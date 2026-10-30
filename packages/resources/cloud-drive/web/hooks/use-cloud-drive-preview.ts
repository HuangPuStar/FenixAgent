/**
 * 云盘文件预览的取数状态机。
 *
 * 预览不是「一次请求拿结果」：转换是异步的，markdown 与页清单都要等 `conversion.status` 进入
 * ready，且页图必须拿清单里的版本号。这里把「轮询 → 取内容 → 失败分类」收在一个 hook 里，组件只渲染
 * 状态；关闭对话框或切换文件时用 `AbortController` 取消在途请求与等待，避免旧结果覆盖新文件。
 *
 * 轮询上限约 30s（`PREVIEW_POLL_BUDGET_MS`）：超过后给超时态与重试，而不是无限转圈。转换失败
 * （failed/blocked）不轮询——重试转换由用户显式触发。
 */

import { unwrap } from "@fenix/web-runtime/api/request";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cloudDriveApi } from "../api/cloud-drive";
import { CLOUD_DRIVE_NS } from "../i18n/namespace";
import { cloudDriveErrorCode, cloudDriveErrorMessage } from "../lib/errors";
import { collectMarkdownPages, PREVIEW_POLL_BUDGET_MS, previewPollDelay } from "../lib/preview";
import { isOfficePreviewName, previewKindFor } from "../lib/preview-kind";
import type { CloudDriveFile, CloudDriveMarkdownPage, CloudDrivePreviewManifest } from "../types/cloud-drive";

export type CloudDrivePreviewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "processing"; readonly conversionStatus: string | null }
  | {
      readonly status: "markdown";
      readonly content: string;
      readonly nextCursor: string | null;
      readonly versionId: string;
      readonly truncated: boolean;
      readonly conversionStatus: string | null;
      readonly loadingMore: boolean;
    }
  | { readonly status: "raster"; readonly manifest: CloudDrivePreviewManifest }
  | { readonly status: "unsupported" }
  | {
      readonly status: "error";
      readonly code: string;
      readonly message: string;
      /** 可以原地重试（网络/限流/上游暂不可用/未就绪）。 */
      readonly canRetry: boolean;
      /** 可以请求重新转换（转换失败或长时间未完成）。 */
      readonly canRetryConversion: boolean;
    };

const NOT_READY_CODES = new Set(["CLOUD_DRIVE_PREVIEW_NOT_READY"]);
const CONVERSION_FAILED_CODES = new Set(["CLOUD_DRIVE_PREVIEW_FAILED"]);
const RETRYABLE_CODES = new Set([
  "NETWORK_ERROR",
  "SERVER_ERROR",
  "CLOUD_DRIVE_UNAVAILABLE",
  "CLOUD_DRIVE_TIMEOUT",
  "CLOUD_DRIVE_RATE_LIMITED",
  "CLOUD_DRIVE_UPSTREAM_ERROR",
  "CLOUD_DRIVE_PREVIEW_NOT_READY",
  "CLOUD_DRIVE_PREVIEW_PAGE_NOT_FOUND",
]);

/** 失败或未完成的转换才值得重新排队；其它状态由服务端 409 兜底。 */
function conversionRetryable(file: CloudDriveFile | null): boolean {
  const status = file?.conversion?.status ?? null;
  return status === "failed" || status === "blocked" || status === "not_converted" || status === null;
}

export function useCloudDrivePreview(open: boolean, file: CloudDriveFile | null) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);
  const [state, setState] = useState<CloudDrivePreviewState>({ status: "idle" });
  const [page, setPageState] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [retryingConversion, setRetryingConversion] = useState(false);
  const runIdRef = useRef(0);
  /** 刚提交重新转换：下一次取数必须先轮询，否则会读到提交前仍是 failed 的旧元数据。 */
  const awaitingConversionRef = useRef(false);

  const textOf = useCallback((error: unknown) => cloudDriveErrorMessage(error, (key) => String(t(key))), [t]);

  const errorState = useCallback(
    (error: unknown): CloudDrivePreviewState => {
      const code = cloudDriveErrorCode(error);
      return {
        status: "error",
        code,
        message: textOf(error),
        canRetry: RETRYABLE_CODES.has(code),
        // 只有「没有可预览产物」类失败才值得重新排队；413/503 等重转同一次也不会变好。
        canRetryConversion:
          CONVERSION_FAILED_CODES.has(code) || (NOT_READY_CODES.has(code) && conversionRetryable(file)),
      };
    },
    [file, textOf],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 是刻意的「重试」信号；file 变化即重新取数。
  useEffect(() => {
    if (!open || !file) {
      setState({ status: "idle" });
      return;
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const controller = new AbortController();
    setState({ status: "loading" });
    setPageState(1);

    const commit = (next: CloudDrivePreviewState) => {
      if (runIdRef.current === runId && !controller.signal.aborted) setState(next);
    };

    const sleep = (delayMs: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

    const fetchMetadata = () => unwrap(cloudDriveApi.getFile(file.id, { signal: controller.signal }));

    /** 轮询元数据直到离开 queued/processing；预算耗尽返回 null（超时已上屏）。 */
    const pollConversion = async (initial: CloudDriveFile, force = false): Promise<CloudDriveFile | null> => {
      let latest = initial;
      let elapsed = 0;
      let pollAttempt = 0;
      // 刚提交重新转换时，元数据可能还停在提交前的 failed：多等两轮，避免把旧状态当成结果。
      let forcedPolls = force ? 2 : 0;
      while (!controller.signal.aborted) {
        const status = latest.conversion?.status ?? null;
        commit({ status: "processing", conversionStatus: status });
        if (elapsed >= PREVIEW_POLL_BUDGET_MS) {
          commit({
            status: "error",
            code: "CLOUD_DRIVE_PREVIEW_TIMEOUT",
            message: String(t("preview.conversionTimeout")),
            canRetry: true,
            canRetryConversion: true,
          });
          return null;
        }
        const delay = previewPollDelay(pollAttempt);
        await sleep(delay);
        if (controller.signal.aborted) return null;
        elapsed += delay;
        pollAttempt += 1;
        latest = await fetchMetadata();
        if (controller.signal.aborted) return null;
        const nextStatus = latest.conversion?.status ?? null;
        if (nextStatus === "queued" || nextStatus === "processing") continue;
        if (forcedPolls > 0) {
          forcedPolls -= 1;
          continue;
        }
        return latest;
      }
      return null;
    };

    const loadMarkdown = async (): Promise<boolean> => {
      const collected = await collectMarkdownPages(async (cursor) => {
        const pageData = await unwrap(
          cloudDriveApi.getMarkdown(file.id, cursor ? { cursor } : {}, { signal: controller.signal }),
        );
        return pageData;
      });
      commit({
        status: "markdown",
        content: collected.content,
        nextCursor: collected.nextCursor,
        versionId: collected.versionId,
        truncated: collected.truncated,
        conversionStatus: collected.conversionStatus,
        loadingMore: false,
      });
      return true;
    };

    const loadRaster = async (): Promise<boolean> => {
      const manifest = await unwrap(cloudDriveApi.getPreview(file.id, { signal: controller.signal }));
      commit({ status: "raster", manifest });
      return true;
    };

    const run = async () => {
      try {
        let metadata = await fetchMetadata();
        if (controller.signal.aborted) return;
        let strategy = previewKindFor(file.name);
        if (strategy === "unsupported") {
          commit({ status: "unsupported" });
          return;
        }

        const status = metadata.conversion?.status ?? null;
        const forcePoll = awaitingConversionRef.current;
        awaitingConversionRef.current = false;
        if (forcePoll || status === "queued" || status === "processing") {
          const converted = await pollConversion(metadata, forcePoll);
          if (!converted) return;
          metadata = converted;
        }

        let polled = forcePoll || status === "queued" || status === "processing";
        // 至多两轮：未就绪时先轮询再重试一次；其余错误直接上屏。
        for (let round = 0; round < 2; round += 1) {
          try {
            if (strategy === "markdown") {
              await loadMarkdown();
            } else {
              await loadRaster();
            }
            return;
          } catch (error) {
            if (
              strategy === "raster" &&
              isOfficePreviewName(file.name) &&
              cloudDriveErrorCode(error) === "CLOUD_DRIVE_UNAVAILABLE"
            ) {
              // 栅格依赖不可用但 markdown 可用：Office 回退，避免把缺 kkfileview 说成「服务坏了」。
              strategy = "markdown";
              continue;
            }
            if (NOT_READY_CODES.has(cloudDriveErrorCode(error)) && !polled) {
              polled = true;
              const converted = await pollConversion(metadata);
              if (!converted) return;
              metadata = converted;
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        commit(errorState(error));
      }
    };

    void run();
    return () => controller.abort();
  }, [open, file, attempt, t, errorState]);

  const setPage = useCallback((next: number) => {
    setPageState((current) => {
      if (!Number.isFinite(next)) return current;
      return Math.max(1, Math.round(next));
    });
  }, []);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const retryConversion = useCallback(async () => {
    if (!file) return;
    setRetryingConversion(true);
    try {
      await unwrap(cloudDriveApi.retryConversion(file.id));
      awaitingConversionRef.current = true;
      setAttempt((value) => value + 1);
    } catch (error) {
      awaitingConversionRef.current = false;
      setState(errorState(error));
    } finally {
      setRetryingConversion(false);
    }
  }, [file, errorState]);

  const loadMore = useCallback(async () => {
    if (!file || state.status !== "markdown" || !state.nextCursor || state.loadingMore) return;
    const current = state;
    setState({ ...current, loadingMore: true });
    try {
      const next = await collectMarkdownPages(
        async (cursor) => {
          const pageData: CloudDriveMarkdownPage = await unwrap(
            cloudDriveApi.getMarkdown(file.id, cursor ? { cursor } : {}),
          );
          return pageData;
        },
        { cursor: current.nextCursor ?? undefined },
      );
      setState({
        status: "markdown",
        content: `${current.content}\n\n${next.content}`,
        nextCursor: next.nextCursor,
        versionId: current.versionId,
        truncated: current.truncated || next.truncated,
        conversionStatus: next.conversionStatus ?? current.conversionStatus,
        loadingMore: false,
      });
    } catch (error) {
      setState(errorState(error));
    }
  }, [file, state, errorState]);

  const pageCount = state.status === "raster" ? state.manifest.pageCount : 0;
  const clampedPage = pageCount > 0 ? Math.min(page, pageCount) : page;

  return {
    state,
    page: clampedPage,
    pageCount,
    setPage,
    retry,
    retryConversion,
    retryingConversion,
    loadMore,
  };
}
