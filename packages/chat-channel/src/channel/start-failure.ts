// packages/chat-channel/src/channel/start-failure.ts
// 启动链路失败的**终结判定**：把任意失败收敛为「公开错误类型 + 关闭码」的有限结论。
//
// 为什么需要统一判定（2026-09-01 事故复盘）：
// - 历史实现只在 ensureRunning 路径做分类，relay 连接/握手路径一律 close 1011，同一确定性
//   失败会因路径不同产生不同重连语义；且三条路径共用同一个 stage，日志无法分辨「实例从未
//   启动」与「实例已启动但 relay 未就绪」——单日 2294 条 INSTANCE_START_FAILED 因此不可诊断。
// - 三条路径共用同一判定后，客户端只需按码判定终态：4500 机器不可用、4502 确定性拒绝、
//   1011 瞬时失败。注意客户端对 1011 有 6 次短连接上限（transport/ws.ts 的
//   MAX_CONSECUTIVE_UNSTABLE_DISCONNECTS），所以本模块的收益是「更早给出准确 Type +
//   少 5 次无效请求 + 可诊断」，而不是消除无限循环。
// - 终态（4500/4502）的代价是客户端停止自动重连，而错误卡片按硬边界 2/9 不得提供重试、
//   重连等恢复操作（docs/arch/23-chat-error-diagnostics.md），因此只有**重连不会改变失败
//   条件**的确定性失败才允许判终态；可自愈的失败（并发配额、重启窗口）必须留在 1011。
//
// 覆盖面提醒：relay 连接/握手路径当前只能观察到 core 抛出的错误（插件与远程 handle 抛的是
// 无 code 的普通 Error，不可分类），因此这两条路径的判定改动主要是语义统一与未来兼容，
// 实际可命中的分类仍以宿主 classifyPermanentSpawnFailure 的返回值为准。
//
// 本模块只做判定（纯函数），日志、发送错误帧、关闭连接等副作用留在 Gateway。

import type { PublicErrorType } from "../public-error";

/** 机器不可用终态：客户端停止自动重连；错误卡片不提供恢复操作，需用户重新进入页面。 */
const MACHINE_OFFLINE_CLOSE_CODE = 4500;
/** 确定性永久失败终态：重连不会改变失败条件。 */
const PERMANENT_FAILURE_CLOSE_CODE = 4502;
/** 瞬时失败：客户端按退避重连。 */
const TRANSIENT_FAILURE_CLOSE_CODE = 1011;
/** 终态关闭码的 reason 语义固定，不随失败路径变化。 */
const MACHINE_OFFLINE_CLOSE_REASON = "machine offline";
const PERMANENT_FAILURE_CLOSE_REASON = "spawn rejected";

/** 启动失败终结判定的输入；三条失败路径（ensureRunning / relay 连接 / relay 握手）共用。 */
export interface StartFailureContext {
  /** 公开错误的诊断阶段；取值属于 docs/arch/23-chat-error-diagnostics.md §7 的有限集合。 */
  stage: string;
  /** 服务端诊断日志前缀（以冒号结尾），与实例标识、错误身份以空格拼接成完整日志行。 */
  logContext: string;
  /** 瞬时失败分支的 close reason，用于在服务端/客户端日志中区分具体失败路径。 */
  transientCloseReason: string;
  /** 连接标识，与 [YJS-WS] Opening 行同源，是日志中**唯一**按请求关联的键。 */
  wsId: string;
  /** 实例标识，同样出现在 [YJS-WS] Opening 行；由请求方提供，只能作为弱关联线索。 */
  instanceUid: string;
}

/** 终结判定所需的宿主能力（GatewayDependencies 的子集，测试可只实现这两项）。 */
export interface StartFailurePolicy {
  isMachineOffline: (err: unknown) => boolean;
  classifyPermanentSpawnFailure: (err: unknown) => string | null;
}

/** 终结判定的结论。 */
export interface StartFailureOutcome {
  type: PublicErrorType;
  closeCode: number;
  closeReason: string;
}

/**
 * 判定启动失败的终结语义。
 *
 * 判定顺序与宿主 `isMachineOfflineError` / `classifyPermanentSpawnFailure` 的
 * 「机器离线与永久失败无交集」契约一致：机器离线优先（4500），其次确定性永久失败
 * （4502），其余一律瞬时失败（1011）。
 */
export function decideStartFailure(
  err: unknown,
  policy: StartFailurePolicy,
  transientCloseReason: string,
): StartFailureOutcome {
  if (policy.isMachineOffline(err)) {
    return {
      type: "CONTROL_PLANE.MACHINE_UNAVAILABLE",
      closeCode: MACHINE_OFFLINE_CLOSE_CODE,
      closeReason: MACHINE_OFFLINE_CLOSE_REASON,
    };
  }
  const permanentCode = policy.classifyPermanentSpawnFailure(err);
  if (permanentCode) {
    return {
      type: mapPermanentFailure(permanentCode),
      closeCode: PERMANENT_FAILURE_CLOSE_CODE,
      closeReason: PERMANENT_FAILURE_CLOSE_REASON,
    };
  }
  return {
    type: "CONTROL_PLANE.INSTANCE_START_FAILED",
    closeCode: TRANSIENT_FAILURE_CLOSE_CODE,
    closeReason: transientCloseReason,
  };
}

/**
 * 确定性永久失败的诊断码 → 公开错误类型。
 *
 * 诊断码由宿主 `classifyPermanentSpawnFailure` 产出，取值集合与宿主一一对应；
 * 未登记的码退回通用启动失败——宁可显示通用原因，不向用户谎报具体事实。
 *
 * 缺席说明：并发配额（`instance_limit_reached`）**故意不在此列**——配额是自愈状态（其它实例
 * 释放或 idle 回收后自然解除），终态却让客户端停止自动重连且错误卡片不得提供重试（硬边界 2/9），
 * 判终态等于把用户关在错误页；保留 1011 让客户端在 6 次退避重连内自愈。代价是
 * `CONTROL_PLANE.INSTANCE_LIMIT_REACHED` 当前没有产出点，按硬边界 8（公开 Type 只增不删）
 * 仍保留在注册表中。
 */
function mapPermanentFailure(code: string): PublicErrorType {
  switch (code) {
    // 请求的实例在 DB 中已不存在（uid 非法、被回收、非本人或与环境不匹配），重连永远不可能成功
    case "instance_not_found":
      return "CONTROL_PLANE.INSTANCE_RECLAIMED";
    case "environment_not_found":
      return "CONTROL_PLANE.ENVIRONMENT_UNAVAILABLE";
    case "auto_start_disabled":
    case "engine_unavailable":
      return "CONTROL_PLANE.CONFIGURATION_INVALID";
    default:
      return "CONTROL_PLANE.INSTANCE_START_FAILED";
  }
}
