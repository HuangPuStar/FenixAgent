/**
 * 工单详情与写路径的编排层：详情取数、字段/指派/状态三个写动作、未确认（待确认）与冲突状态机、核对结果。
 *
 * **写动作不用 `useRequest` 的 `onSuccess`/`onError` 回调，而是 `runAsync` + 显式 try/catch**：一次用户动作
 * 的终局不是「成功/失败」两种，而是五种（已生效 / 202 待确认 / 版本冲突 / 在途互斥 / 其它失败），且每种
 * 都要触发不同副作用（就地替换、置待确认、保留草稿、自动刷新）。写在回调里会让「终局」散成
 * `onSuccess` 与 `onError` 两处，调用方（弹窗要不要关、草稿留不留）无从取用，故收敛成返回
 * {@link TicketWriteOutcome} 的异步动作。取数仍全部走 `useRequest`。
 *
 * 三条不变量：
 * 1. **页面数据只有一处被写**：成功返回的新视图经 {@link TicketWritePort.applyTicket} 就地替换
 *    （`mutate`），不再回源一次——第二次请求既慢又会在并发下用旧响应覆盖新响应；
 * 2. **幂等键由一个动作表面持有**（字段/指派/状态各一把），签名含 `expectedVersion`：版本变化
 *    （即用户是在另一份内容上重试）自动换代，冲突刷新后不需要任何「清键」分支；
 * 3. **未确认的写阻止后续修改**：`blocked` 时所有写动作直接短路，不发请求（服务端也会拒绝，界面提前告知）。
 *    待确认 id 有两个来源——本地 202 与详情快照的 `pendingOperationId`（跨刷新可见）；核对出终态失败后
 *    用 {@link settledOperationId} 把快照里的旧 id 抵消，否则用户会被一个已终结的操作永久锁住。
 */

import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TicketOperationStatus } from "../api/ticket-operations";
import { ticketOperationsApi } from "../api/ticket-operations";
import type { TicketDetail, TicketState, TicketUpdateBody, TicketWriteResult } from "../api/tickets";
import { ticketApi } from "../api/tickets";
import { TICKETS_NS } from "../i18n/namespace";
import { settleTicketWriteFailure } from "../lib/ticket-write-failure";
import type { IdempotencyKeyHolder, TicketWriteOutcome } from "../lib/ticket-write-outcome";
import { createIdempotencyKeyHolder, isUncertainAccepted, writeSignature } from "../lib/ticket-write-outcome";

/**
 * 页面注入给其它写路径（标签、评论）的出口：它们的 200/202/409 都汇进详情页**唯一**的写状态机，
 * 避免同一工单出现两个横幅或两套「待确认」口径。
 */
export interface TicketWritePort {
  /** 有未确认的写操作：所有写入口禁用（方案 §9.6）。 */
  readonly blocked: boolean;
  /** 用写响应返回的新视图就地替换页面数据（不再回源）。 */
  readonly applyTicket: (ticket: TicketDetail) => void;
  /** 202 上报：待确认态由详情写状态机单点持有。 */
  readonly reportUncertain: (operationId: string) => void;
  /** 单值动作冲突后的自动刷新（读取幂等）；有草稿的动作不得调用它（草稿不能丢）。 */
  readonly reloadLatest: () => void;
}

/**
 * 核对后仍会留在横幅上的结论。**终态（`succeeded` / `failed`）不在其中**：终态一确定，待确认态随即解除、
 * 横幅随之卸载，留在横幅里的结论用户根本看不到——那两种结论因此走 toast（见 `resolveOperation`）。
 */
export type TicketResolution = Exclude<TicketOperationStatus, "succeeded" | "failed"> | "checkFailed" | null;

export interface UseTicketDetailResult extends TicketWritePort {
  data: TicketDetail | undefined;
  loading: boolean;
  error: Error | undefined;
  refresh: () => void;
  /** 任一写动作进行中（页面据此禁用其余写入口）。 */
  busy: boolean;
  /** 待确认的操作 id（本地 202 或服务端快照）；非空即 `blocked`。 */
  pendingOperationId: string | null;
  /** 字段编辑冲突：草稿必须保留，由用户手动点「加载最新内容」。 */
  fieldsConflict: boolean;
  /** 核对结果；请求本身失败时返回 `null`（横幅不变，不改变页面主状态）。 */
  resolveOperation: () => Promise<TicketOperationStatus | null>;
  resolving: boolean;
  /** 最近一次核对里**仍留在横幅上**的结论；终态与请求失败分别见 `resolveOperation` 的 toast 与 `checkFailed`。 */
  resolution: TicketResolution;
  submitFields: (values: { title: string; body: string }) => Promise<TicketWriteOutcome>;
  assign: (assigneeId: string | null) => Promise<TicketWriteOutcome>;
  changeState: (state: TicketState) => Promise<TicketWriteOutcome>;
}

/** 写请求载荷：请求体与本次动作的幂等键一起传（键由动作表面持有，请求层不碰它）。 */
interface UpdatePayload {
  body: TicketUpdateBody;
  key: string;
}

export function useTicketDetail(projectId: string, number: string): UseTicketDetailResult {
  const { t } = useTranslation(TICKETS_NS);
  const [acceptedOperationId, setAcceptedOperationId] = useState<string | null>(null);
  const [settledOperationId, setSettledOperationId] = useState<string | null>(null);
  const [fieldsConflict, setFieldsConflict] = useState(false);
  const [resolution, setResolution] = useState<TicketResolution>(null);

  const detail = useRequest(async () => unwrap(ticketApi.get(projectId, number)), {
    refreshDeps: [projectId, number],
    onError: (err: Error) => {
      // 服务端 `message` 优先上屏（它才是可定位的失败原因），字典文案只在它是空串时兜底。
      console.error("ticket detail load failed", err);
      toast.error(err.message || t("toast.detailLoadFailed"));
    },
  });

  // 换工单后必须清掉上一单的本地写状态：待确认 id、冲突与核对结论都只属于上一单，留着会让新工单平白
  // 多一条横幅，或让写入口被一个与它无关的操作 id 锁住。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 两个路由参数是刻意的重置触发信号，effect 体只用 setter。
  useEffect(() => {
    setAcceptedOperationId(null);
    setSettledOperationId(null);
    setFieldsConflict(false);
    setResolution(null);
  }, [projectId, number]);

  /** 三个动作表面各持一把键，绝不跨动作共享（服务端的请求指纹含 kind 与 target，共用会立刻幂等冲突）。 */
  const fieldsHolder = useMemo(() => createIdempotencyKeyHolder(), []);
  const assignHolder = useMemo(() => createIdempotencyKeyHolder(), []);
  const stateHolder = useMemo(() => createIdempotencyKeyHolder(), []);

  const serverPendingId = detail.data?.pendingOperationId ?? null;
  const pendingOperationId = acceptedOperationId ?? (serverPendingId === settledOperationId ? null : serverPendingId);
  const blocked = pendingOperationId !== null;

  const applyTicket = useCallback(
    (ticket: TicketDetail) => {
      detail.mutate(ticket);
    },
    [detail.mutate],
  );

  const reportUncertain = useCallback((operationId: string) => {
    setAcceptedOperationId(operationId);
  }, []);

  const reloadLatest = useCallback(() => {
    // 冲突态随「加载最新内容」一起撤掉；刷新本身是幂等读，失败由 useRequest 的 onError 提示。
    setFieldsConflict(false);
    detail.refresh();
  }, [detail.refresh]);

  /** 三个动作表面打的是同一个 HTTP 调用（`PATCH /tickets/:projectId/:number`），差别只在各自的幂等键。 */
  const writeTicket = async (body: TicketUpdateBody, key: string) =>
    unwrap(ticketApi.update(projectId, number, body, key));
  // 各动作仍各持一个 request 实例：`runAsync` 在「同一实例上后到的请求」会把先到的 promise 挂起
  //（ahooks 的取消语义），共用实例会让两个动作互相吞掉对方的终局。
  const fieldsRequest = useRequest(async (payload: UpdatePayload) => writeTicket(payload.body, payload.key), {
    manual: true,
  });
  const assignRequest = useRequest(async (payload: UpdatePayload) => writeTicket(payload.body, payload.key), {
    manual: true,
  });
  const stateRequest = useRequest(async (payload: UpdatePayload) => writeTicket(payload.body, payload.key), {
    manual: true,
  });
  const resolveRequest = useRequest(async (operationId: string) => unwrap(ticketOperationsApi.get(operationId)), {
    manual: true,
  });

  /**
   * 失败终局分类交给 `lib/ticket-write-failure`（三条写路径共用矩阵）；差异化的副作用留在这里：
   * 冲突**不产生**副作用——有草稿的动作要保留草稿并显示内联提示，无草稿的单值动作才自动刷新。
   */
  const settleWriteError = (
    error: unknown,
    holder: IdempotencyKeyHolder,
    failureMessageKey: string,
  ): TicketWriteOutcome =>
    settleTicketWriteFailure(error, {
      t,
      holder,
      failureMessageKey,
      logLabel: "ticket write failed",
      // 在途互斥与「资源已不在原处」都只需要把页面拉回最新：一个由快照的 pendingOperationId 接管界面，
      // 一个让四态分支重新判定。
      onOperationPending: () => detail.refresh(),
      onNotFound: () => detail.refresh(),
    });

  /** 成功终局：202 只上报待确认（键保留，期间不重发）；200 就地替换 + 换代（同一界面要能连发下一个动作）。 */
  const applyWriteResult = (
    result: TicketWriteResult,
    holder: IdempotencyKeyHolder,
    successMessageKey: string,
    acceptedMessageKey: string,
  ): TicketWriteOutcome => {
    if (isUncertainAccepted(result)) {
      reportUncertain(result.operationId);
      toast.warning(t(acceptedMessageKey));
      return "accepted";
    }
    holder.reset();
    applyTicket(result.ticket);
    toast.success(t(successMessageKey));
    return "applied";
  };

  const submitFields = async (values: { title: string; body: string }): Promise<TicketWriteOutcome> => {
    const current = detail.data;
    if (blocked || current === undefined) return "blocked";
    setFieldsConflict(false);
    // 标题与描述在同一个表单里 → 单次 PATCH：两个字段参与同一份内容指纹，拆成两次会产生一个中间版本，
    // 并让第二笔请求的 expectedVersion 立刻过期。
    const body: TicketUpdateBody = { title: values.title, body: values.body, expectedVersion: current.version };
    const key = fieldsHolder.take(writeSignature([values.title, values.body, current.version]));
    try {
      const result = await fieldsRequest.runAsync({ body, key });
      return applyWriteResult(result, fieldsHolder, "edit.saved", "edit.accepted");
    } catch (error) {
      const outcome = settleWriteError(error, fieldsHolder, "edit.failed");
      if (outcome === "conflict") setFieldsConflict(true);
      return outcome;
    }
  };

  const assign = async (assigneeId: string | null): Promise<TicketWriteOutcome> => {
    const current = detail.data;
    if (blocked || current === undefined) return "blocked";
    // `assigneeId: null` 与「字段省略」语义不同（取消指派 vs 不改），签名把 null 归一成空串即可区分。
    const key = assignHolder.take(writeSignature([assigneeId ?? "", current.version]));
    try {
      const result = await assignRequest.runAsync({
        body: { assigneeId, expectedVersion: current.version },
        key,
      });
      return applyWriteResult(result, assignHolder, "assignee.updated", "assignee.accepted");
    } catch (error) {
      const outcome = settleWriteError(error, assignHolder, "assignee.failed");
      // 指派是无草稿的单值动作：冲突后自动刷新一次（读取幂等），没有需要用户重新确认的中间态。
      if (outcome === "conflict") {
        toast.error(t("write.conflict"));
        reloadLatest();
      }
      return outcome;
    }
  };

  const changeState = async (state: TicketState): Promise<TicketWriteOutcome> => {
    const current = detail.data;
    if (blocked || current === undefined) return "blocked";
    const key = stateHolder.take(writeSignature([state, current.version]));
    try {
      const result = await stateRequest.runAsync({ body: { state, expectedVersion: current.version }, key });
      return applyWriteResult(
        result,
        stateHolder,
        state === "closed" ? "state.closed" : "state.reopened",
        "state.accepted",
      );
    } catch (error) {
      const outcome = settleWriteError(error, stateHolder, "state.failed");
      // 关闭/重开同样是无草稿的单值动作：冲突后自动刷新一次，用户重新点一次即可（关闭仍需再确认）。
      if (outcome === "conflict") {
        toast.error(t("write.conflict"));
        reloadLatest();
      }
      return outcome;
    }
  };

  const resolveOperation = async (): Promise<TicketOperationStatus | null> => {
    if (pendingOperationId === null) return null;
    try {
      const operation = await resolveRequest.runAsync(pendingOperationId);
      if (operation.status === "succeeded" || operation.status === "failed") {
        // 终态：撤掉待确认，并把这个 id 记为「已终结」，抵消详情快照里可能还留着的同一个 id。结论走 toast 而
        // 不是横幅——待确认态一解除横幅就卸载了，写在横幅里的结论会随它一起消失。
        setAcceptedOperationId(null);
        setSettledOperationId(pendingOperationId);
        setResolution(null);
        if (operation.status === "succeeded") {
          toast.success(t("write.statusSucceeded"));
          detail.refresh();
        } else {
          toast.error(t("write.statusFailed"));
        }
      } else {
        setResolution(operation.status);
      }
      return operation.status;
    } catch (error) {
      console.error("ticket operation resolve failed", error);
      setResolution("checkFailed");
      return null;
    }
  };

  return {
    data: detail.data,
    loading: detail.loading,
    error: detail.error,
    refresh: detail.refresh,
    busy: fieldsRequest.loading || assignRequest.loading || stateRequest.loading,
    pendingOperationId,
    blocked,
    applyTicket,
    reportUncertain,
    reloadLatest,
    fieldsConflict,
    resolveOperation,
    resolving: resolveRequest.loading,
    resolution,
    submitFields,
    assign,
    changeState,
  };
}
