// src/services/chat-channel-bootstrap.ts
// Chat 域宿主桥接层（C7）：包内 ChatChannelDependencies 的宿主实现装配与单例缓存。
//
// 复制编排域桥接模式（orchestration-bootstrap.ts / orchestration-instance.ts）：
// - _deps 惰性引用宿主模块单例，setChatChannelBootstrapDeps(null) 供测试注入 fake
//   （测试禁止直接 mock.module，CLAUDE.md 质量红线）；
// - getChatChannelController 惰性构造并缓存单例，resetChatChannelBootstrap 仅用于测试。
//
// 单例缓存是必要的：SessionChannel 构造时会向 DocManager 注册权限请求回调（单槽位
// 装配点），重复构造会覆盖前者导致权限超时迁移失效，因此一个进程内至多一个控制器。

import type { ChatChannelDependencies } from "@fenix/chat-channel/server";
import {
  ChatChannelController,
  classifyPermanentSpawnFailure,
  docManager,
  isMachineOfflineError,
} from "@fenix/chat-channel/server";
import { log, error as logError } from "@fenix/logger";
import {
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  touchInstanceActivity,
} from "../../services/acp-idle-monitor";
import { refreshInstanceEnvironment, terminateLocalDeadInstance } from "../../services/orchestration-instance";
import { getAgentRuntimeConfig } from "../config";
import { environmentRepo } from "../repositories/environment";
import { connectAgentRelay } from "../transport/agent-relay";
import { bindRelayLifecyclePort } from "../transport/relay/lifecycle-port";
import { agentInstanceService } from "./agent-instance-service";
import { resolveWorkspacePath } from "./workspace-resolver";

type ChatChannelBootstrapDeps = {
  environmentRepo: typeof environmentRepo;
  resolveWorkspacePath: typeof resolveWorkspacePath;
  ensureRunning: (ownerUserId: string, environmentId: string, requestedInstanceUid?: string) => Promise<string>;
  connectAgentRelay: typeof connectAgentRelay;
  refreshInstanceEnvironment: typeof refreshInstanceEnvironment;
  markInstanceRelayAttached: typeof markInstanceRelayAttached;
  markInstanceRelayDetached: typeof markInstanceRelayDetached;
  touchInstanceActivity: typeof touchInstanceActivity;
  terminateLocalDeadInstance: typeof terminateLocalDeadInstance;
  docManager: typeof docManager;
  isMachineOfflineError: typeof isMachineOfflineError;
  classifyPermanentSpawnFailure: typeof classifyPermanentSpawnFailure;
  log: typeof log;
  logError: typeof logError;
  maxClients: () => number;
};

const defaultDeps: ChatChannelBootstrapDeps = {
  environmentRepo,
  resolveWorkspacePath,
  ensureRunning: async (ownerUserId, environmentId, requestedInstanceUid) => {
    const instance = await agentInstanceService.resolveInstanceForOperation({
      environmentId,
      ownerUserId,
      requestedInstanceUid,
      automaticSelection: "chat",
    });
    await agentInstanceService.ensureInstanceRuntime(instance);
    return instance.id;
  },
  connectAgentRelay,
  refreshInstanceEnvironment,
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  touchInstanceActivity,
  terminateLocalDeadInstance,
  docManager,
  isMachineOfflineError,
  classifyPermanentSpawnFailure,
  log,
  logError,
  // 连接上限取模块配置（1.7 C1）：原先直读 `process.env.YJS_MAX_CLIENTS` 并 `|| 200` 兜底——非法值静默回落
  // 到 200、负值被原样接受。schema 已随 `envDefinitions` 迁到本模块 manifest，启动期校验保证此处必是正整数。
  // 闭包保持惰性：`defaultDeps` 是模块级常量，装配期求值会撞上「基础设施尚未初始化」。
  maxClients: () => getAgentRuntimeConfig().yjsMaxClients,
};

let deps: ChatChannelBootstrapDeps = defaultDeps;

/** 测试用：覆盖桥接层依赖（部分覆盖，未覆盖字段回落默认实现）；传 null 恢复默认。 */
export function setChatChannelBootstrapDeps(overrides: Partial<ChatChannelBootstrapDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

function buildChatChannelDependencies(): ChatChannelDependencies {
  return {
    docManager: deps.docManager,
    // 路由和宿主边界均要求当前用户是 Environment owner，避免组织成员间共享 runtime/workspace。
    authorizeEnvironment: (userId, environment) => Boolean(environment.userId) && environment.userId === userId,
    getEnvironment: deps.environmentRepo.getById.bind(deps.environmentRepo),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    ensureRunning: deps.ensureRunning,
    connectAgentRelay: deps.connectAgentRelay,
    refreshInstanceEnvironment: deps.refreshInstanceEnvironment,
    markRelayAttached: deps.markInstanceRelayAttached,
    markRelayDetached: deps.markInstanceRelayDetached,
    touchInstanceActivity: deps.touchInstanceActivity,
    terminateLocalDeadInstance: (instanceId) => {
      // orchestration-instance 的回收是异步的；relay 断链路径不等待回收完成，
      // 避免阻塞消息处理循环（回收失败由该函数内部日志保留诊断上下文）。
      void deps.terminateLocalDeadInstance(instanceId);
    },
    isMachineOffline: deps.isMachineOfflineError,
    classifyPermanentSpawnFailure: deps.classifyPermanentSpawnFailure,
    maxClients: deps.maxClients,
    log: deps.log,
    reportError: deps.logError,
  };
}

let controller: ChatChannelController | null = null;

/** 获取 Chat 域控制器单例（YJS WS 入口与连接注册表的统一访问点）。 */
export function getChatChannelController(): ChatChannelController {
  if (!controller) {
    controller = new ChatChannelController(buildChatChannelDependencies());
  }
  return controller;
}

bindRelayLifecyclePort({
  closeClientsByInstance: (instanceId, code, reason) =>
    getChatChannelController().registry.closeClientsByInstance(instanceId, code, reason),
  reclaimInstanceRealtimeResources: (instanceId) =>
    getChatChannelController().relayEvents.reclaimInstanceRealtimeResources(instanceId),
  closeAllClients: (code, reason) => getChatChannelController().registry.closeAll(code, reason),
});

/** 重置控制器单例缓存（仅用于测试；测试注入依赖后必须重置才能生效）。 */
export function resetChatChannelBootstrap(): void {
  controller = null;
}
