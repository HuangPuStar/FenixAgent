// packages/chat-channel/src/channel/controller.ts
// ChatChannelController：Chat 域控制面的单例组装点（C7 宿主桥接）。
//
// 包内各控制面模块（Gateway / SessionChannel / RelayEventHandler / broadcaster /
// connection-registry）均为纯协议实现，宿主能力（环境解析、workspace、实例生命周期、
// relay 连接、空闲监控、Redis 快照、日志）统一收敛为 ChatChannelDependencies 构造器
// 注入；宿主的 src/services/chat-channel-bootstrap.ts 用真实实现装配本类，协议层测试
// 可用 fake 依赖注入（Q10/Q12）。
//
// 单例由宿主侧缓存（getChatChannelController / resetChatChannelBootstrap）：SessionChannel
// 构造时会向 DocManager 注册权限请求回调（单槽位装配点），重复构造会覆盖前者导致
// 权限超时迁移失效，因此一个进程内至多存在一个控制器实例。

import type { DocManager } from "../state";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import type { ClientConnection } from "./connection-types";
import { Gateway, type GatewayEnvironment } from "./gateway";
import { RelayEventHandler } from "./relay-event-handler";
import { SessionChannel, type SessionConnection } from "./session-channel";

/** Chat 域宿主依赖（全部经构造器注入，包内禁止直接 import src/ 宿主模块） */
export interface ChatChannelDependencies {
  /** 全局 DocManager 实例（宿主构造：Redis 惰性获取） */
  docManager: DocManager;
  /** 环境解析（宿主 environmentRepo 语义） */
  getEnvironment: (agentId: string) => Promise<GatewayEnvironment | undefined>;
  /** 纵深防御授权：组织环境由路由 authContext 决定访问权，个人环境校验 owner */
  authorizeEnvironment: (userId: string, environment: GatewayEnvironment) => boolean;
  /** workspace 注入（宿主 resolveWorkspacePath 语义）：{WORKSPACE_ROOT}/{orgId}/{userId}/{environmentId} */
  resolveWorkspacePath: (orgId: string, userId: string, agentId: string) => string;
  /** 实例生命周期（宿主 ensureRunning 语义）：先复用运行实例，仅创建新实例时检查并发配额 */
  ensureRunning: (
    userId: string,
    agentId: string,
    mode: "interactive",
    instanceNumber?: number,
  ) => Promise<{ instance: { id: string } }>;
  /** relay 连接（宿主 connectAgentRelay 语义） */
  connectAgentRelay: (instanceId: string, rcsSessionId: string) => Promise<ClientConnection["relayHandle"]>;
  /** 空闲监控（宿主 acp-idle-monitor 语义）：relay 附着/分离与活跃观测 */
  markRelayAttached: (instanceId: string) => void;
  markRelayDetached: (instanceId: string) => void;
  touchInstanceActivity: (instanceId: string, raw: Record<string, unknown>) => void;
  /** 本地死实例回收（宿主 orchestration-instance 语义，内部校验 nodeId） */
  terminateLocalDeadInstance: (instanceId: string) => void;
  /** Redis 快照持久化（宿主 cache/yjs-store 语义）：会话切换前以 CAS 持久化 Session Doc */
  prepareClearSessionSnapshot: (connection: SessionConnection) => Promise<void>;
  /** 从 DB sessionId 解析 instance 编号（多实例 YJS doc 隔离） */
  resolveInstanceNumberFromSession: (sessionId: string) => Promise<number>;
  /** 机器离线判定（宿主注入）：true → close 4500 终态（客户端停止自动重连） */
  isMachineOffline: (err: unknown) => boolean;
  /** 确定性永久失败分类（宿主注入）：返回诊断码 → close 4502 终态；null → 1011 可重连 */
  classifyPermanentSpawnFailure: (err: unknown) => string | null;
  /** YJS 连接配额（宿主 env 语义，默认 200） */
  maxClients: () => number;
  /** 诊断日志（宿主 log 语义，禁止包含敏感内容） */
  log: (message: string) => void;
  /** 错误日志（宿主 error 语义，保留诊断上下文、对外脱敏） */
  reportError: (message: string, error: unknown) => void;
  /** 切换模型拦截校验（可选，设计 §5.2）：engine 模型标识解析回 UUID 校验 ∈ 预选列表 */
  validateSetSessionModel?: (connection: SessionConnection, modelId: string) => Promise<void>;
  /** 预选模型状态解析（可选，设计 §5.1）：agent_config.modelIds → 会话级 modelState */
  resolvePresetModelState?: (
    rcsSessionId: string,
    agentId: string,
  ) => Promise<{ currentModelId: string; availableModels: Array<{ modelId: string; name: string }> } | null>;
}

/** Chat 域控制面组装：持有网关入口与连接注册表（供宿主关闭连接）。 */
export class ChatChannelController {
  readonly registry: ConnectionRegistry;
  readonly broadcaster: YjsBroadcaster;
  readonly sessionChannel: SessionChannel;
  readonly relayEvents: RelayEventHandler;
  readonly gateway: Gateway;

  constructor(dependencies: ChatChannelDependencies) {
    this.registry = new ConnectionRegistry();
    this.broadcaster = new YjsBroadcaster(this.registry);
    this.sessionChannel = new SessionChannel({
      docManager: dependencies.docManager,
      prepareClearSessionSnapshot: dependencies.prepareClearSessionSnapshot,
      // 会话切换后同步 ACP session ID 到同一 RCS 会话的所有客户端，
      // 使同一会话的多标签页保持一致，且不污染其他 RCS 会话（YJS 不变量 8）。
      syncSessionId: (connection, newSessionId) => {
        this.registry.forEachByRcsSession(connection.rcsSessionId, (other) => {
          other.acpSessionId = newSessionId;
          other.sessionLoaded = true;
        });
      },
      reportError: dependencies.reportError,
      // 模型切换拦截与预选注入（设计 §5）：宿主可选注入，未配置预选时放行
      ...(dependencies.validateSetSessionModel
        ? { validateSetSessionModel: dependencies.validateSetSessionModel }
        : {}),
      ...(dependencies.resolvePresetModelState
        ? { resolvePresetModelState: dependencies.resolvePresetModelState }
        : {}),
    });
    this.relayEvents = new RelayEventHandler({
      registry: this.registry,
      broadcaster: this.broadcaster,
      docManager: dependencies.docManager,
      registerYjsDocListener: this.broadcaster.registerYjsDocListener.bind(this.broadcaster),
      reportError: dependencies.reportError,
      touchInstanceActivity: dependencies.touchInstanceActivity,
      terminateLocalDeadInstance: dependencies.terminateLocalDeadInstance,
      ...(dependencies.resolvePresetModelState
        ? { resolvePresetModelState: dependencies.resolvePresetModelState }
        : {}),
      // 命令回执（set_session_model 等）转发到 SessionChannel 处理模型切换回滚
      onRpcResponse: (rpcId, ok) => this.sessionChannel.handleModelSwitchResponse(rpcId, ok),
    });
    this.gateway = new Gateway({
      registry: this.registry,
      broadcaster: this.broadcaster,
      relayEvents: this.relayEvents,
      sessionChannel: this.sessionChannel,
      docManager: dependencies.docManager,
      getEnvironment: dependencies.getEnvironment,
      authorizeEnvironment: dependencies.authorizeEnvironment,
      resolveWorkspacePath: dependencies.resolveWorkspacePath,
      ensureRunning: dependencies.ensureRunning,
      connectAgentRelay: dependencies.connectAgentRelay,
      markRelayAttached: dependencies.markRelayAttached,
      markRelayDetached: dependencies.markRelayDetached,
      reportLog: dependencies.log,
      reportError: dependencies.reportError,
      maxClients: dependencies.maxClients,
      resolveInstanceNumberFromSession: dependencies.resolveInstanceNumberFromSession,
      isMachineOffline: dependencies.isMachineOffline,
      classifyPermanentSpawnFailure: dependencies.classifyPermanentSpawnFailure,
    });
  }
}
