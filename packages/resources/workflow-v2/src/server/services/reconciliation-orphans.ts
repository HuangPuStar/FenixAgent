/**
 * 对账任务（4A）的第二段：孤儿补写与创建补偿收敛。
 *
 * 「孤儿」= 上游 `workflow_list` 列出、而本地注册表不认识的对象。两个来源：创建时本地写库失败
 * （`workflow.create.compensation` / `pending_cleanup`），以及历史数据丢失。两者处置相反：
 * - 有**未收敛**补偿标记的对象是「应当被删除」的一次失败创建——删除并追加 `cleaned` 终结标记，
 *   绝不在补写路径上被认领（否则用户会看到一个自己收到过 500 的工作流）；
 * - 没有标记的对象才是真正需要补写的归属行。
 *
 * 归属判据（本设计最核心的安全约束，设计 §3.4）：`space_id` 取平台账号台账（我们唯一能访问的空间），
 * `project_id` 取本地 `workflow_v2_org_app` 的 `app_id`；对象出现在「这两个值共同约束的列表」里，
 * 才按**发起这次查询的那个绑定行**的 `organization_id` 补写。任何一处对不上都 fail-closed：只计数 + 告警，
 * 不补写——把当前组织无权属的对象写成自己组织的，是越权。
 *
 * 审计表只追加，因此补偿收敛用**新行**表达（`result = 'cleaned'`）；已收敛的标记既不重复删除也不补写。
 *
 * 覆盖边界（已知限制，不是缺陷）：扫描以「本地已绑定 App」为入口，因此**只看得到挂在某个租户 App 下的对象**
 * （`workflow_list` 的 `project_id` 是硬过滤，契约快照 §3 F1）。平台账号直接建在个人空间、不属于任何 App 的
 * 对象不在扫描范围内，也就不会被补写——它们本来就没有归属可反查（没有 `project_id` 就没有对应的租户），
 * 补写只会是猜测。移除条件：上游提供「按 space 列出全部对象并回显归属」的接口时，可改为按 space 全量对账。
 */

import { createLogger } from "@fenix/logger";
import {
  CLEANED_RESULT,
  type CompensationMarkerRow,
  CREATE_COMPENSATION_ACTION,
  PENDING_CLEANUP_RESULT,
} from "../repositories/audit-log-repository";
import { WORKFLOW_AUDIT_ACTIONS } from "./audit-trail";
import {
  BACKFILLED_OWNER_USER_ID,
  classifyRejectedResponse,
  classifyThrownFailure,
  isCancelled,
  isDeleteAccepted,
  isRecord,
  RECONCILIATION_ACTOR_USER_ID,
  type ReconciliationRunContext,
  readPorts,
  readUpstreamCode,
  tallyFailure,
} from "./reconciliation-ports";

const logger = createLogger("wf2-reconciliation");

/** 上游 `workflow_list` 的分页大小与每组织最多翻几页（缺省 100 × 5 = 500 个对象/轮）。 */
const ORPHAN_PAGE_SIZE = 100;
const ORPHAN_MAX_PAGES = 5;

/** 每轮最多处理的孤儿候选数：补写是写库动作，超过这个量说明数据面已异常，留给下一轮并告警。 */
const ORPHAN_MAX_CANDIDATES_PER_RUN = 100;

/** 孤儿扫描一轮的计数。 */
export interface OrphanStats {
  /** 参与扫描的租户 App 绑定数。 */
  readonly organizations: number;
  /** 上游列出的对象数（原始条数）。 */
  readonly upstream: number;
  readonly backfilled: number;
  /** 创建补偿对象被确认删除（写入 `cleaned` 终结标记）。 */
  readonly cleaned: number;
  readonly cleanupFailed: number;
  /** 归属无法确定而跳过的候选（列表项自报 project_id 不符、身份属于别的组织、缺 workflow_id、标记组织不符）。 */
  readonly undetermined: number;
}

/** 一个待处置的候选（上游存在、本地未登记）。 */
interface OrphanCandidate {
  readonly organizationId: string;
  readonly appId: string;
  readonly upstreamWorkflowId: string;
  readonly name: string | null;
}

/**
 * 扫描全部租户 App 的上游对象，返回本地注册表不认识的候选。
 *
 * 列表项若回显 `project_id` 且与查询条件不符，或该身份已被别的组织登记，一律不进候选并计入
 * `undetermined`——这两条是防御性的 fail-closed 判据：上游行为变化（列表项开始回显归属）或数据异常
 * （同 id 被两个组织登记）都不该让我们写出错误归属。
 */
async function collectOrphanCandidates(
  context: ReconciliationRunContext,
  spaceId: string,
  orgApps: readonly { organizationId: string; appId: string }[],
): Promise<{ candidates: OrphanCandidate[]; upstream: number; undetermined: number; truncated: boolean }> {
  const ports = readPorts();
  const candidates: OrphanCandidate[] = [];
  let upstream = 0;
  let undetermined = 0;
  let truncated = false;

  for (const app of orgApps) {
    if (isCancelled(context)) break;
    const known = new Set(await ports.listKnownUpstreamIds(app.organizationId));
    for (let page = 1; page <= ORPHAN_MAX_PAGES; page += 1) {
      if (isCancelled(context) || candidates.length >= ORPHAN_MAX_CANDIDATES_PER_RUN) {
        truncated = true;
        break;
      }
      let result: Awaited<ReturnType<typeof ports.callUpstream>>;
      try {
        result = await ports.callUpstream({
          path: "/api/workflow_api/workflow_list",
          body: { space_id: spaceId, project_id: app.appId, page, size: ORPHAN_PAGE_SIZE },
        });
      } catch (error) {
        tallyFailure(context.failures, classifyThrownFailure(error));
        logger.warn("workflow-v2 对账：孤儿扫描的上游调用失败，本轮提前结束", {
          appId: app.appId,
          page,
          error: error instanceof Error ? error.message : String(error),
        });
        return { candidates, upstream, undetermined, truncated };
      }

      const data = isRecord(result.body) && isRecord(result.body.data) ? result.body.data : null;
      if (result.status !== 200 || readUpstreamCode(result.body) !== 0 || data === null) {
        tallyFailure(context.failures, classifyRejectedResponse(result));
        logger.warn("workflow-v2 对账：孤儿扫描被上游拒绝，本轮提前结束", {
          appId: app.appId,
          page,
          upstreamStatus: result.status,
          upstreamCode: readUpstreamCode(result.body),
        });
        return { candidates, upstream, undetermined, truncated };
      }
      const list = Array.isArray(data.workflow_list) ? data.workflow_list : [];

      for (const item of list) {
        upstream += 1;
        if (!isRecord(item) || typeof item.workflow_id !== "string" || item.workflow_id.length === 0) {
          undetermined += 1;
          logger.warn("workflow-v2 对账：上游列表项缺少 workflow_id，跳过", { appId: app.appId, page });
          continue;
        }
        const upstreamWorkflowId = item.workflow_id;
        // 上游列表项原则上不回显 project_id（契约快照 §3 F1），回显时则必须与查询条件一致。
        const echoedProjectId = item.project_id;
        if (typeof echoedProjectId === "string" && echoedProjectId.length > 0 && echoedProjectId !== app.appId) {
          undetermined += 1;
          logger.warn("workflow-v2 对账：上游列表项的 project_id 与查询条件不符，拒绝补写", {
            upstreamWorkflowId,
            appId: app.appId,
          });
          continue;
        }
        if (known.has(upstreamWorkflowId)) continue;
        if ((await ports.findRegisteredId(upstreamWorkflowId)) !== undefined) {
          undetermined += 1;
          logger.warn("workflow-v2 对账：上游身份已被别的组织登记，拒绝补写", {
            upstreamWorkflowId,
            appId: app.appId,
          });
          continue;
        }
        candidates.push({
          organizationId: app.organizationId,
          appId: app.appId,
          upstreamWorkflowId,
          name: typeof item.name === "string" && item.name.length > 0 ? item.name : null,
        });
        if (candidates.length >= ORPHAN_MAX_CANDIDATES_PER_RUN) {
          truncated = true;
          break;
        }
      }

      if (truncated) break;
      const total = data.total;
      if (list.length < ORPHAN_PAGE_SIZE) break;
      if (typeof total === "number" && page * ORPHAN_PAGE_SIZE >= total) break;
      if (page === ORPHAN_MAX_PAGES) truncated = true;
    }
  }
  return { candidates, upstream, undetermined, truncated };
}

/**
 * 处理一个候选：先看创建补偿标记（应删），再补写归属行（应认领）。
 *
 * 补写走「先查后写 + 唯一索引兜底」：`collectOrphanCandidates` 已查过本地与世界，但并发（多副本同时补写、
 * 或用户此刻正好重建了同 id 对象）仍可能撞唯一索引；写失败计入 `undetermined` 并告警，不重试——下一轮
 * 的 `known` 集合会包含这一行，冲突自然消失。
 */
async function processCandidate(
  context: ReconciliationRunContext,
  candidate: OrphanCandidate,
  spaceId: string,
  marker: { unresolved: boolean; organizationId: string } | null,
  stats: { backfilled: number; cleaned: number; cleanupFailed: number; undetermined: number },
): Promise<void> {
  const ports = readPorts();

  if (marker === null) {
    try {
      await ports.insertWorkflow({
        organizationId: candidate.organizationId,
        upstreamWorkflowId: candidate.upstreamWorkflowId,
        appId: candidate.appId,
        // 上游列表项没有名字时用上游身份兜底：宁可让列表显示一个可检索的标识，也不留空名。
        name: candidate.name ?? candidate.upstreamWorkflowId,
        ownerUserId: BACKFILLED_OWNER_USER_ID,
        visibility: "private",
      });
      stats.backfilled += 1;
      await ports.appendAuditLog({
        organizationId: candidate.organizationId,
        actorUserId: RECONCILIATION_ACTOR_USER_ID,
        action: WORKFLOW_AUDIT_ACTIONS.reconcileBackfill,
        upstreamWorkflowId: candidate.upstreamWorkflowId,
        requestId: null,
        result: "ok",
        errorCode: null,
      });
    } catch (error) {
      stats.undetermined += 1;
      tallyFailure(context.failures, "local_failure");
      logger.error("workflow-v2 对账：孤儿补写失败", {
        organizationId: candidate.organizationId,
        upstreamWorkflowId: candidate.upstreamWorkflowId,
        appId: candidate.appId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  // 标记属于别的组织：候选是通过本组织的 App 列表发现的，两者不符时归属无法确定，不动作。
  if (marker.organizationId !== candidate.organizationId) {
    stats.undetermined += 1;
    logger.warn("workflow-v2 对账：创建补偿标记的组织与 App 绑定不符，跳过", {
      upstreamWorkflowId: candidate.upstreamWorkflowId,
      appId: candidate.appId,
    });
    return;
  }
  // 已收敛的标记：既不补写也不重复删除。
  if (!marker.unresolved) return;

  try {
    const result = await ports.callUpstream({
      path: "/api/workflow_api/delete",
      body: { workflow_id: candidate.upstreamWorkflowId, space_id: spaceId },
    });
    if (!isDeleteAccepted(result)) {
      stats.cleanupFailed += 1;
      tallyFailure(context.failures, classifyRejectedResponse(result));
      logger.warn("workflow-v2 对账：创建补偿对象删除未被接受", {
        organizationId: candidate.organizationId,
        upstreamWorkflowId: candidate.upstreamWorkflowId,
        upstreamStatus: result.status,
        upstreamCode: readUpstreamCode(result.body),
      });
      return;
    }
    await ports.appendAuditLog({
      organizationId: candidate.organizationId,
      actorUserId: RECONCILIATION_ACTOR_USER_ID,
      action: CREATE_COMPENSATION_ACTION,
      upstreamWorkflowId: candidate.upstreamWorkflowId,
      requestId: null,
      result: CLEANED_RESULT,
      errorCode: null,
    });
    stats.cleaned += 1;
  } catch (error) {
    stats.cleanupFailed += 1;
    tallyFailure(context.failures, classifyThrownFailure(error));
    logger.warn("workflow-v2 对账：创建补偿对象删除失败", {
      organizationId: candidate.organizationId,
      upstreamWorkflowId: candidate.upstreamWorkflowId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 一个身份的收敛状态：只要有 `cleaned` 行就算收敛完成（审计表只追加，一个 id 可能有多行标记）。 */
function resolveMarkerState(
  markers: readonly CompensationMarkerRow[],
): Map<string, { unresolved: boolean; organizationId: string }> {
  const byId = new Map<string, { unresolved: boolean; organizationId: string }>();
  for (const marker of markers) {
    const current = byId.get(marker.upstreamWorkflowId);
    const unresolved = marker.result === PENDING_CLEANUP_RESULT;
    // 已见「未收敛」再见到「已收敛」时以收敛为准；反向组合保持未收敛（终结行尚未出现）。
    if (current === undefined || (current.unresolved && !unresolved)) {
      byId.set(marker.upstreamWorkflowId, { unresolved, organizationId: marker.organizationId });
    }
  }
  return byId;
}

/** 扫描并处置孤儿候选；`spaceId` 为 null 时由调用方跳过（没有空间 ID 就列不出上游对象）。 */
export async function reconcileOrphans(
  context: ReconciliationRunContext,
  spaceId: string,
  stats: {
    organizations: number;
    upstream: number;
    backfilled: number;
    cleaned: number;
    cleanupFailed: number;
    undetermined: number;
  },
): Promise<void> {
  const ports = readPorts();
  const orgApps = await ports.listOrgApps();
  stats.organizations = orgApps.length;

  const scan = await collectOrphanCandidates(context, spaceId, orgApps);
  stats.upstream = scan.upstream;
  stats.undetermined += scan.undetermined;
  if (scan.truncated) {
    // 达到本轮上限不是失败，但必须显式告警：否则「对账一直只处理前 100 个」会永远静默。
    tallyFailure(context.failures, "budget_exhausted");
    logger.warn("workflow-v2 对账：孤儿扫描达到本轮上限，剩余对象留待下一轮", {
      scanned: scan.upstream,
      candidates: scan.candidates.length,
    });
  }

  const markers = resolveMarkerState(
    await ports.findCompensationMarkers(scan.candidates.map((item) => item.upstreamWorkflowId)),
  );
  for (const candidate of scan.candidates) {
    if (isCancelled(context)) break;
    await processCandidate(context, candidate, spaceId, markers.get(candidate.upstreamWorkflowId) ?? null, stats);
  }
}
