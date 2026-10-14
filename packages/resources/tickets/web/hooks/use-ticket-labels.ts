/**
 * 工单标签的编排层：项目标签目录（只读）+ 目标集合的**全量提交**。
 *
 * 全量语义（PUT 的 `labelIds` 是目标集合而不是增量）决定了三件事：
 * 1. 勾选是本地草稿，与服务端集合的差异就是全部状态：集合相同 → 保存按钮禁用（没有变更就没有动作，
 *    也不消耗幂等键）；达到上限 → 未勾选的行禁用（前端只做提前告知，最终由服务端拒绝）。
 * 2. 草稿**按版本重置**：`draft` 记住自己是在哪个 `version` 上构建的，版本一变（成功回填、冲突后的
 *    自动刷新、别处刷新）就退回服务端集合。冲突后「保留旧勾选」看着像保住了用户输入，实际是让
 *    一份基于旧集合的意图去覆盖他人的改动；退回最新集合后用户重新勾选，界面上永远是服务端事实。
 *    版本做键（而不是 effect 里手写几条 `set*`）也让重置是**派生**的，不存在漏同步的中间帧。
 * 3. 请求体的 `labelIds` 先排序：集合语义与顺序无关，而请求体参与服务端的幂等指纹——「取消勾选又勾回来」
 *    会得到相同集合、不同顺序的请求体，若复用同一把键就会撞 `IDEMPOTENCY_CONFLICT`。排序让两者指纹一致。
 *
 * **不做乐观更新**（与列表/详情的只读口径一致）：chips 只在服务端确认后才变，失败时用户看到旧集合、
 * 勾选草稿原样保留，可直接再点保存（复用同一把键）。
 *
 * 冲突（409）按**单值动作**处置（裁定三.20 把标签与指派/状态归为一类）：自动刷新一次把最新集合与版本取回，
 * 而不是留一个要用户手点的「加载最新内容」。前端合同 §6.2 曾把标签写成「保留草稿 + 手动刷新」，与
 * §8.1 的「无草稿动作自动刷新一次」及三.20 的明确归类冲突，以后者为准——标签的草稿按版本重置，
 * 刷新后它本就回到服务端集合，再让用户多点一次没有信息增量。
 */

import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TicketDataSource } from "../api/ticket-data-source";
import type { TicketProjectLabel } from "../api/ticket-projects";
import type { TicketDetail } from "../api/tickets";
import { TICKETS_NS } from "../i18n/namespace";
import { settleTicketWriteFailure } from "../lib/ticket-write-failure";
import type { TicketWriteOutcome } from "../lib/ticket-write-outcome";
import { createIdempotencyKeyHolder, isUncertainAccepted, writeSignature } from "../lib/ticket-write-outcome";

/**
 * 单张工单的标签上限。与后端 `src/server/services/ticket-limits.ts` 的 `LABEL_MAX_COUNT` 是同一条业务
 * 约束：包内 web 面不能 import 服务端实现（浏览器 bundle 会把 drizzle 一起拖进去），故各自持有常量；
 * 前端这份只用于提前禁用，判定权在服务端。
 */
export const LABEL_MAX_COUNT = 20;

export interface TicketLabelsOptions {
  /** 编辑区是否展开：目录只在展开后取，详情页默认不为它多打一次请求。 */
  readonly enabled: boolean;
  /** 当前工单视图：草稿按它的版本初始化，`expectedVersion` 也从它取。 */
  readonly ticket: TicketDetail | undefined;
  /** 详情写状态机的出口（见 `TicketWritePort`）：202 上报与冲突后的自动刷新都汇进页面唯一的写状态机。 */
  readonly blocked: boolean;
  readonly applyTicket: (ticket: TicketDetail) => void;
  readonly reportUncertain: (operationId: string) => void;
  /** 单值动作冲突后的自动刷新（读取幂等）；标签没有需要用户保留的草稿，见文件头。 */
  readonly reloadLatest: () => void;
}

export interface TicketLabelsState {
  catalog: TicketProjectLabel[];
  catalogLoading: boolean;
  catalogError: Error | undefined;
  retryCatalog: () => void;
  /** 勾选草稿（目标集合）；与服务端当前集合一致时 `dirty === false`。 */
  draftIds: string[];
  toggle: (labelId: string) => void;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<TicketWriteOutcome>;
}

/**
 * 标签编排层。
 *
 * `source` 是**依赖**而不是行为开关：控制台面与平台管理面共用同一套「全量集合提交 + 草稿按版本重置」规则，
 * 差别只在请求打到哪个协议面（见 `api/ticket-data-source`）。
 */
export function useTicketLabels(
  projectId: string,
  number: string,
  source: TicketDataSource,
  options: TicketLabelsOptions,
): TicketLabelsState {
  const { t } = useTranslation(TICKETS_NS);
  const [draft, setDraft] = useState<{ version: string; ids: string[] } | null>(null);
  const holder = useMemo(() => createIdempotencyKeyHolder(), []);
  const { blocked, ticket } = options;

  const catalogRequest = useRequest(async () => unwrap(source.projects.labels(projectId)), {
    ready: options.enabled,
    refreshDeps: [projectId, options.enabled],
    onError: (err: Error) => {
      // 目录失败的主反馈是编辑区里的错误态 + 重试（它就在用户眼前），不额外弹 toast。
      console.error("ticket labels catalog load failed", err);
    },
  });

  const saveRequest = useRequest(
    async (payload: { labelIds: string[]; expectedVersion: string; key: string }) =>
      unwrap(
        source.tickets.setLabels(
          projectId,
          number,
          { labelIds: payload.labelIds, expectedVersion: payload.expectedVersion },
          payload.key,
        ),
      ),
    { manual: true },
  );

  const serverIds = useMemo(() => ticket?.labels.map((label) => label.id) ?? [], [ticket?.labels]);
  const version = ticket?.version;
  // 草稿只在「它构建时的那一版」上有效：版本变化即作废，退回服务端集合（见文件头第 2 条）。
  const draftIds = draft !== null && version !== undefined && draft.version === version ? draft.ids : serverIds;
  const dirty = [...draftIds].sort().join(",") !== [...serverIds].sort().join(",");

  const toggle = (labelId: string): void => {
    if (version === undefined) return;
    const ids = draftIds.includes(labelId) ? draftIds.filter((id) => id !== labelId) : [...draftIds, labelId];
    setDraft({ version, ids });
  };

  const save = async (): Promise<TicketWriteOutcome> => {
    if (blocked || ticket === undefined) return "blocked";
    // 没有变更就没有动作：提前返回，既不发请求也不消耗幂等键。
    if (!dirty) return "blocked";
    const sorted = [...draftIds].sort();
    const key = holder.take(writeSignature([sorted.join(","), ticket.version]));
    try {
      const result = await saveRequest.runAsync({ labelIds: sorted, expectedVersion: ticket.version, key });
      if (isUncertainAccepted(result)) {
        options.reportUncertain(result.operationId);
        toast.warning(t("labels.accepted"));
        return "accepted";
      }
      holder.reset();
      options.applyTicket(result.ticket);
      // 回填的新视图带着新版本，草稿已自动回到服务端集合；清掉草稿条目，避免留一份永不命中的旧版本键。
      setDraft(null);
      toast.success(t("labels.saved"));
      return "applied";
    } catch (error) {
      const outcome = settleTicketWriteFailure(error, {
        t,
        holder,
        failureMessageKey: "labels.failed",
        logLabel: "ticket labels write failed",
      });
      // 单值动作：冲突不留给用户处置，直接刷新一次拿回最新集合与版本（草稿随版本重置，见文件头）。
      if (outcome === "conflict") {
        toast.error(t("write.conflict"));
        options.reloadLatest();
      }
      return outcome;
    }
  };

  return {
    catalog: catalogRequest.data?.items ?? [],
    catalogLoading: catalogRequest.loading,
    catalogError: catalogRequest.error,
    retryCatalog: catalogRequest.refresh,
    draftIds,
    toggle,
    dirty,
    saving: saveRequest.loading,
    save,
  };
}
