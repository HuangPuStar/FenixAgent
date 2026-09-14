// src/services/chat-channel-error-classify.ts
// Chat 域桥接层的 spawn 错误分类（C7 迁移自 src/transport/relay/yjs-frontend/offline-error.ts，
// 随 yjs-frontend 目录删除收拢到桥接层；语义原样保留）。

import { isCoreRuntimeError } from "@fenix/core";
import { OrchestrationError } from "@fenix/orchestration";
import { AppError } from "../errors";

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
 * 返回诊断码当且仅当该失败是确定性永久失败：重连不会改变失败条件，自动重连只会制造
 * 永不成功的循环；此时调用方应关闭为终态码 4502。返回 null 表示瞬时/未知失败，应保留
 * 1011 自动重连（并发配额、DB 抖动、机器断连窗口、实例重启窗口）。
 * 与 isMachineOfflineError 无交集（机器离线仍走 4500 专用终态）。
 *
 * 诊断码是**服务端内部**取值，不随公开错误帧下发（帧里只有 type/id/message）；诊断码 →
 * 公开 Type 的映射表在 packages/chat-channel 的 start-failure.ts，新增码必须同步该映射，
 * 否则客户端只会收到通用 INSTANCE_START_FAILED。
 *
 * 判终态的代价是客户端停止自动重连，而当前 UI 没有恢复入口，因此**只有确实不可自愈**的
 * 失败才允许进入本函数返回码集合（可自愈的并发配额、重启窗口必须保持 null）。
 */
export function classifyPermanentSpawnFailure(err: unknown): string | null {
  if (err instanceof AppError) {
    if (err.code === "AUTO_START_DISABLED") return "auto_start_disabled";
    // 实例不存在：DB 事实（uid 非法、被回收、非本人或与环境不匹配），重连不会改变结论。
    // 只认 AppError 形态；core 的内存快照缺失（CoreRuntimeError.INSTANCE_NOT_FOUND）不同——
    // see isCoreRuntimeError 分支。
    if (err.code === "INSTANCE_NOT_FOUND") return "instance_not_found";
    // 并发配额（AGENT_CONCURRENCY_LIMIT_REACHED / USER_ / SCHEDULED_，来源 agent-concurrency.ts）
    // 故意保持传输瞬时：配额会在用户 stop 掉其它实例后自然释放，判终态会让用户在无恢复入口的
    // 错误页里等到刷新页面；保留 1011 由客户端 6 次短连接上限收口。
    return null;
  }
  if (err instanceof OrchestrationError) {
    // 与 AUTO_START_DISABLED 同类的配置性永久失败：如 RCS_DISABLE_LOCAL_EXECUTION 且无远程机器时
    // controller.spawnInstance 每次必然抛 LaunchSpecBuildError（orchestration-instance.ts 注释），
    // 重连不改变配置，同样属于确定性永久失败。
    if (err.code === "LAUNCH_SPEC_BUILD_FAILED") return "launch_spec_build_failed";
    // 环境被删除或不再属于该用户：重连不改变数据事实
    if (err.code === "ENVIRONMENT_NOT_FOUND") return "environment_not_found";
    return null;
  }
  if (isCoreRuntimeError(err)) {
    // 引擎/插件缺失属部署与配置事实，重连不改变；注意 INVALID_INSTANCE_STATE 不在此列：
    // 实例可能正在重启，属瞬时窗口，必须保留自动重连
    if (err.code === "ENGINE_NOT_SUPPORTED" || err.code === "NO_ENGINE_AVAILABLE" || err.code === "PLUGIN_NOT_FOUND") {
      return "engine_unavailable";
    }
    // core 侧实例快照已不存在（进程回收 / relay 建立前快照被清理）：与宿主 INSTANCE_NOT_FOUND 同义
    if (err.code === "INSTANCE_NOT_FOUND") return "instance_not_found";
    return null;
  }
  return null;
}
