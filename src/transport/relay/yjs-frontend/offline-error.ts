import { isCoreRuntimeError } from "@fenix/core";
import { OrchestrationError } from "@fenix/orchestration";
import { AppError } from "../../../errors";

/**
 * YJS 前端 WS 打开阶段的 spawn 错误分类（机器离线 + 确定性永久失败）。
 *
 * 机器离线在 spawn 链路上以三种形态出现，对客户端语义等价（目标机器不可达，
 * 自动重连无意义，应 close 4500 进入终态并等待用户手动重试）：
 *   - OrchestrationError.MACHINE_OFFLINE：编排域保留错误码（当前无生产抛出点，
 *     未来机器状态透传修复（A-P1.2）启用后自动兼容本判定）；
 *   - OrchestrationError.AGENT_NODE_UNAVAILABLE：AgentNodeService.ensureNode 在
 *     节点未注册、已回收或未处于 connected 状态时抛出（agent-node-service.ts），
 *     spawn 语境下等价机器不可达；releaseNode 的同类异常只在 stop 路径，到不了
 *     WS 打开阶段；
 *   - CoreRuntimeError NODE_OFFLINE / NODE_NOT_FOUND：core launchInstance 在目标
 *     节点非 online（机器断连，unregisterRemoteNode 置 offline）或缺失时抛出；
 *     当前主断连窗口已被 ensureNode 的 connected 门禁拦截，此形态仅剩
 *     ensureNode 检查通过后、core launch 前断连的毫秒级竞态窗口。
 * AppError.MACHINE_OFFLINE 一并兼容（历史/外部调用方可能直接使用该形态）。
 *
 * 注意：本判定只服务于 WS 打开阶段的错误分类；HTTP 路径的状态映射由
 * plugins/error-handler.ts 的 ORCHESTRATION_STATUS_MAP 负责，两者互不替代。
 */
export function isMachineOfflineError(err: unknown): boolean {
  if (err instanceof AppError) return err.code === "MACHINE_OFFLINE";
  if (err instanceof OrchestrationError) {
    return err.code === "MACHINE_OFFLINE" || err.code === "AGENT_NODE_UNAVAILABLE";
  }
  if (isCoreRuntimeError(err)) {
    return err.code === "NODE_OFFLINE" || err.code === "NODE_NOT_FOUND";
  }
  return false;
}

/**
 * WS 打开阶段 spawn 失败的「永久性」判定。
 *
 * 返回诊断码（客户端 payload.code）当且仅当该失败是确定性永久失败：
 * 重连不会改变失败条件（autoStart 开关、maxSessions 上限、launch spec 构建条件均为配置态），
 * 自动重连只会制造永不成功的循环；此时调用方应关闭为终态码并交由用户手动重试。
 * 返回 null 表示瞬时/未知失败，应保留 1011 自动重连（如并发竞态、内部注册窗口）。
 * 与 isMachineOfflineError 无交集（机器离线仍走 4500 专用终态）。
 */
export function classifyPermanentSpawnFailure(err: unknown): string | null {
  if (err instanceof AppError) {
    if (err.code === "AUTO_START_DISABLED") return "auto_start_disabled";
    if (err.code === "MAX_SESSIONS_REACHED") return "max_sessions_reached";
    return null;
  }
  if (err instanceof OrchestrationError) {
    // 与 AUTO_START_DISABLED 同类的配置性永久失败：如 RCS_DISABLE_LOCAL_EXECUTION 且无远程机器时
    // controller.spawnInstance 每次必然抛 LaunchSpecBuildError（orchestration-instance.ts 注释），
    // 重连不改变配置，同样属于确定性永久失败。
    if (err.code === "LAUNCH_SPEC_BUILD_FAILED") return "launch_spec_build_failed";
    return null;
  }
  return null;
}
