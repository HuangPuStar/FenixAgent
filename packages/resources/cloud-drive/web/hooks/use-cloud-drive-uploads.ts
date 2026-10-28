/**
 * 上传队列：多文件入队、逐文件进度、串行执行、失败续传/重传、取消。
 *
 * 串行而非并发的原因：CloudDrive 的写入在冷启动时可达数十秒，多个 4 MiB 分片并发只会互相争用同一条
 * 后端代理链路；串行还能让「进度」与「谁在传」在 UI 里始终一致。真正的分片/续传/410 重建在
 * `../lib/upload`（纯逻辑、已单独测），本 hook 只负责 React 状态与用户反馈。
 *
 * 上传会话 ID 保存在内部记录里：重试时带着它走续传（先 GET status 取服务端 offset），
 * 只有服务端返回 410/404 时 `runChunkedUpload` 才会重建会话。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { createCloudDriveUploadPort } from "../api/cloud-drive";
import { CLOUD_DRIVE_NS } from "../i18n/namespace";
import { cloudDriveErrorMessage, isAbortError } from "../lib/errors";
import { runChunkedUpload } from "../lib/upload";

export type CloudDriveUploadStatus = "queued" | "uploading" | "finalizing" | "done" | "error" | "canceled";

/** 上传面板里的一行；`message` 只在失败时非空（服务端原文优先）。 */
export interface CloudDriveUploadTask {
  id: string;
  name: string;
  sizeBytes: number;
  uploadedBytes: number;
  status: CloudDriveUploadStatus;
  message: string | null;
}

interface UploadRecord {
  file: File;
  parentId: string | null;
  uploadId: string | null;
  controller: AbortController | null;
  canceled: boolean;
}

interface UseCloudDriveUploadsOptions {
  /** 上传完成（含覆盖写）后刷新列表与配额。 */
  onCompleted?: () => void;
}

const ACTIVE_STATUSES = new Set<CloudDriveUploadStatus>(["queued", "uploading", "finalizing"]);

/** 判断某条任务是否仍在进行；页面据此禁止重复提交同一文件。 */
export function isActiveUploadStatus(status: CloudDriveUploadStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** 上传队列的唯一入口。 */
export function useCloudDriveUploads({ onCompleted }: UseCloudDriveUploadsOptions = {}) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);
  const [tasks, setTasks] = useState<CloudDriveUploadTask[]>([]);

  const tasksRef = useRef<CloudDriveUploadTask[]>([]);
  const recordsRef = useRef(new Map<string, UploadRecord>());
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef(false);
  const portRef = useRef(createCloudDriveUploadPort());
  /** 最新的 `t` 与回调：串行 runner 的生命周期跨多次渲染，不能捕获首帧闭包。 */
  const handlersRef = useRef({ t, onCompleted });
  handlersRef.current = { t, onCompleted };

  const updateTask = useCallback((id: string, patch: Partial<CloudDriveUploadTask>) => {
    tasksRef.current = tasksRef.current.map((task) => (task.id === id ? { ...task, ...patch } : task));
    setTasks(tasksRef.current);
  }, []);

  const errorText = useCallback((error: unknown) => {
    const translate = handlersRef.current.t;
    return cloudDriveErrorMessage(error, (key) => String(translate(key)));
  }, []);

  const uploadOne = useCallback(
    async (id: string) => {
      const record = recordsRef.current.get(id);
      if (!record || record.canceled) return;

      const controller = new AbortController();
      record.controller = controller;
      updateTask(id, { status: "uploading", message: null });

      try {
        await runChunkedUpload(portRef.current, {
          parentId: record.parentId,
          file: record.file,
          signal: controller.signal,
          resumeUploadId: record.uploadId,
          onProgress: (uploadedBytes) => {
            updateTask(id, {
              uploadedBytes,
              status: uploadedBytes >= record.file.size ? "finalizing" : "uploading",
            });
          },
          onSessionChange: (uploadId) => {
            record.uploadId = uploadId;
          },
        });
        updateTask(id, { status: "done", uploadedBytes: record.file.size });
        toast.success(handlersRef.current.t("upload.success", { name: record.file.name }));
        handlersRef.current.onCompleted?.();
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          updateTask(id, { status: "canceled", message: null });
          const uploadId = record.uploadId;
          record.uploadId = null;
          if (uploadId) void portRef.current.abandon(uploadId).catch(() => undefined);
        } else {
          const message = errorText(error);
          updateTask(id, { status: "error", message });
          toast.error(handlersRef.current.t("upload.failedWith", { message }));
        }
      } finally {
        record.controller = null;
      }
    },
    [errorText, updateTask],
  );

  /** 串行执行队列；`runningRef` 保证同一时刻只有一个 runner。 */
  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const id = queueRef.current.shift();
        if (id) await uploadOne(id);
      }
    } finally {
      runningRef.current = false;
    }
  }, [uploadOne]);

  /** 入队一批文件；同名同大小的在途任务会被拒绝（避免同一文件重复提交）。 */
  const addFiles = useCallback(
    (files: readonly File[], parentId: string | null) => {
      if (files.length === 0) return;

      const activeKeys = new Set(
        tasksRef.current
          .filter((task) => isActiveUploadStatus(task.status))
          .map((task) => `${task.name}\u0000${task.sizeBytes}`),
      );
      const duplicates: string[] = [];
      const created: CloudDriveUploadTask[] = [];

      for (const file of files) {
        const key = `${file.name}\u0000${file.size}`;
        if (activeKeys.has(key)) {
          duplicates.push(file.name);
          continue;
        }
        activeKeys.add(key);
        const id = crypto.randomUUID();
        recordsRef.current.set(id, {
          file,
          parentId,
          uploadId: null,
          controller: null,
          canceled: false,
        });
        const task: CloudDriveUploadTask = {
          id,
          name: file.name,
          sizeBytes: file.size,
          uploadedBytes: 0,
          status: "queued",
          message: null,
        };
        created.push(task);
        queueRef.current.push(id);
      }

      if (created.length > 0) {
        tasksRef.current = [...tasksRef.current, ...created];
        setTasks(tasksRef.current);
        void pump();
      }
      for (const name of duplicates) {
        toast.error(handlersRef.current.t("upload.duplicate", { name }));
      }
    },
    [pump],
  );

  /** 失败/取消的任务重新入队；有会话 ID 时走续传。 */
  const retry = useCallback(
    (id: string) => {
      const task = tasksRef.current.find((entry) => entry.id === id);
      if (!task || (task.status !== "error" && task.status !== "canceled")) return;
      const record = recordsRef.current.get(id);
      if (!record) return;
      record.canceled = false;
      updateTask(id, { status: "queued", message: null });
      queueRef.current.push(id);
      void pump();
    },
    [pump, updateTask],
  );

  /** 取消：排队中直接出队，上传中中止连接并放弃会话。 */
  const cancel = useCallback(
    (id: string) => {
      const record = recordsRef.current.get(id);
      const task = tasksRef.current.find((entry) => entry.id === id);
      if (!record || !task) return;
      record.canceled = true;
      if (record.controller) record.controller.abort();
      else updateTask(id, { status: "canceled", message: null });
    },
    [updateTask],
  );

  /** 清掉已完成/已取消的行；失败行保留，便于重试。 */
  const clearFinished = useCallback(() => {
    tasksRef.current = tasksRef.current.filter((task) => task.status === "error");
    const remaining = new Set(tasksRef.current.map((task) => task.id));
    for (const id of recordsRef.current.keys()) {
      if (!remaining.has(id)) recordsRef.current.delete(id);
    }
    setTasks(tasksRef.current);
  }, []);

  // 卸载时中止在途上传，避免请求落在已卸载组件的回调上。
  useEffect(() => {
    const records = recordsRef.current;
    return () => {
      for (const record of records.values()) record.controller?.abort();
    };
  }, []);

  const activeCount = tasks.filter((task) => isActiveUploadStatus(task.status)).length;

  return { tasks, activeCount, addFiles, retry, cancel, clearFinished };
}
