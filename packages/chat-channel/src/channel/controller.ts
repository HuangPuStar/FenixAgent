// packages/chat-channel/src/channel/controller.ts
// ChatChannelController：Chat 域控制面的单例组装点（C7 宿主桥接）。
//
// 包内各控制面模块（Gateway / SessionChannel / RelayEventHandler / broadcaster /
// connection-registry）均为纯协议实现，宿主能力（环境解析、workspace、实例生命周期、
// relay 连接、空闲监控、Redis 快照、日志）统一收敛为 ChatChannelDependencies 构造器
// 注入；packages/agent-runtime/src/server/services/chat-channel-bootstrap.ts 用真实实现
// 装配本类，协议层测试可用 fake 依赖注入（Q10/Q12）。
//
// 单例由宿主侧缓存（getChatChannelController / resetChatChannelBootstrap）：SessionChannel
// 构造时会向 DocManager 注册权限请求回调（单槽位装配点），重复构造会覆盖前者导致
// 权限超时迁移失效，因此一个进程内至多存在一个控制器实例。

import type { SnapshotPersistConfigSource } from "../persist/snapshot-config";
import type { DocManager } from "../state";
import type { ProjectionDocs } from "../types";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import type { ChatSyncProtocolConfig, ClientConnection } from "./connection-types";
import { Gateway, type GatewayEnvironment } from "./gateway";
import { RelayEventHandler } from "./relay-event-handler";
import { SessionChannel } from "./session-channel";
import type { GatewaySyncHostOverrides } from "./sync-connection";

/** attach 窗口内暂存的用户消息上限：只覆盖首 prompt 竞态，不承接长期离线队列。 */
const MAX_PENDING_USER_MESSAGES = 8;

/** 跨进程 legacy 换代复核周期：与 sync 连接同一量级，避免每个广播都查 Redis。 */
const LEGACY_GENERATION_WATCH_INTERVAL_MS = 2_000;

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
  /** 持久实例生命周期：省略 UID 时解析 user/default，并经 Coordinator ensure。 */
  ensureRunning: (ownerUserId: string, agentId: string, requestedInstanceUid?: string) => Promise<string>;
  /** 当前 Agent 运行身份，只从宿主 Core 读取。 */
  getRuntimeIdentity?: (instanceId: string) => string | undefined;
  /** relay 连接（宿主 connectAgentRelay 语义） */
  connectAgentRelay: (instanceId: string, rcsSessionId: string) => Promise<ClientConnection["relayHandle"]>;
  /** 新 ACP session 创建前刷新复用实例的 workspace 配置与 Skills。 */
  refreshInstanceEnvironment: (instanceId: string, agentId: string, userId: string) => Promise<void>;
  /** 空闲监控（宿主 acp-idle-monitor 语义）：relay 附着/分离与活跃观测 */
  markRelayAttached: (instanceId: string) => void;
  markRelayDetached: (instanceId: string) => void;
  touchInstanceActivity: (instanceId: string, raw: Record<string, unknown>) => void;
  /** 本地死实例回收（宿主 orchestration-instance 语义，内部校验 nodeId） */
  /** 机器离线判定（宿主注入）：true → close 4500 终态（客户端停止自动重连） */
  isMachineOffline: (err: unknown) => boolean;
  /** 确定性永久失败分类（宿主注入）：返回诊断码 → close 4502 终态；null → 1011 可重连 */
  classifyPermanentSpawnFailure: (err: unknown) => string | null;
  /** YJS 连接配额（宿主 env 语义，默认 200） */
  maxClients: () => number;
  /** 新聊天同步协议装配配置；缺省关闭，旧路径行为不变。 */
  chatSyncProtocol?: ChatSyncProtocolConfig;
  /** 同步运行时注入（观测/测试用假时钟）；生产缺省使用系统时钟。 */
  syncHostOverrides?: GatewaySyncHostOverrides;
  /**
   * 快照节流 / TTL 参数来源（宿主 `RCS_YJS_SNAPSHOT_*` 投影）。惰性求值：宿主模块配置在应用基础设施
   * 初始化完成后才可读，构造本控制器时可能尚未就绪。
   */
  snapshotPersist: SnapshotPersistConfigSource;
  /** 诊断日志（宿主 log 语义，禁止包含敏感内容） */
  log: (message: string) => void;
  /** 错误日志（宿主 error 语义，保留诊断上下文、对外脱敏） */
  reportError: (message: string, error: unknown) => void;
}

/** Chat 域控制面组装：持有网关入口与连接注册表（供宿主关闭连接）。 */
export class ChatChannelController {
  readonly registry: ConnectionRegistry;
  readonly broadcaster: YjsBroadcaster;
  readonly sessionChannel: SessionChannel;
  readonly relayEvents: RelayEventHandler;
  readonly gateway: Gateway;
  /** 跨进程 legacy 投影复核（公开以便测试与诊断主动触发）。 */
  readonly legacyGenerationWatcher: LegacyGenerationWatcher;

  constructor(dependencies: ChatChannelDependencies) {
    this.registry = new ConnectionRegistry();
    // 快照参数装入共享 DocManager（单槽位装配点）：它由宿主桥接层构造、与本控制器同源，
    // 且只在打开 Doc 时惰性求值，因此先于下面任何 Doc 打开路径完成装配。
    dependencies.docManager.setSnapshotPersistConfigSource(dependencies.snapshotPersist);
    // reportLog 注入 broadcaster：SP-0 帧打点与 SP-A7 lagging/resync 生命周期日志
    this.broadcaster = new YjsBroadcaster(this.registry, { reportLog: dependencies.log });
    this.sessionChannel = new SessionChannel({
      docManager: dependencies.docManager,
      refreshInstanceEnvironment: (connection) =>
        dependencies.refreshInstanceEnvironment(connection.instanceId, connection.agentId, connection.userId),
      replaceProjection: (projection) => {
        this.registry.forEachByRcsSession(projection.rcsSessionId, (client) => {
          // 动作 socket（legacy）上的 load_session 正是这次换代的调用方；关掉它会释放共享 relay，
          // 让该命令以 "Relay is closed" 失败。legacy 连接改由下方强制 replace 帧换代。
          if (!client.syncConnection && !client.syncOnly) return;
          client.syncClosed = true;
          const connection = client.syncConnection;
          client.syncConnection = undefined;
          try {
            client.ws.close(1012, "projection replaced");
            connection?.dispose();
          } catch (error) {
            dependencies.reportError("[YJS-FE] projection connection invalidation failed", error);
          }
        });
        const chatName = `chat:${projection.rcsSessionId}`;
        const sessionName = `session:${projection.rcsSessionId}`;
        this.broadcaster.registerYjsDocListener(projection.chat.ydoc, chatName, projection.generation);
        this.broadcaster.registerYjsDocListener(projection.session.ydoc, sessionName, projection.generation);
        // force：绕过背压门禁，legacy 连接不能因丢 replace 帧停在旧代次。
        this.broadcaster.broadcastReplacement(projection.chat.ydoc, chatName, projection.generation, true);
        this.broadcaster.broadcastReplacement(projection.session.ydoc, sessionName, projection.generation, true);
      },
      // 会话切换后同步 ACP session ID 到同一 RCS 会话的所有客户端，
      // 使同一会话的多标签页保持一致，且不污染其他 RCS 会话（YJS 不变量 8）。
      syncSessionId: (connection, newSessionId) => {
        this.registry.forEachByRcsSession(connection.rcsSessionId, (other) => {
          other.acpSessionId = newSessionId;
          other.sessionLoaded = true;
        });
      },
      publishUserMessage: (rcsSessionId, turnId, text) => {
        this.registry.forEachByRcsSession(rcsSessionId, (client) => {
          if (client.syncConnection) {
            client.syncConnection.acceptUserMessage(turnId, text);
            return;
          }
          // attach 窗口内的首条消息不能丢：连接就绪后按序补水（有界，避免旧客户端积压）。
          const pending = client.pendingSyncUserMessages ?? [];
          pending.push({ turnId, text });
          if (pending.length > MAX_PENDING_USER_MESSAGES) pending.shift();
          client.pendingSyncUserMessages = pending;
        });
      },
      reportError: dependencies.reportError,
      reportLog: dependencies.log,
    });
    this.relayEvents = new RelayEventHandler({
      registry: this.registry,
      broadcaster: this.broadcaster,
      docManager: dependencies.docManager,
      registerYjsDocListener: this.broadcaster.registerYjsDocListener.bind(this.broadcaster),
      reportError: dependencies.reportError,
      log: dependencies.log,
      touchInstanceActivity: dependencies.touchInstanceActivity,
      invalidateRuntimeSession: (rcsSessionId) => this.sessionChannel.invalidateRuntimeSession(rcsSessionId),
      onNormalizedEvent: (rcsSessionId, event) => {
        this.registry.forEachByRcsSession(rcsSessionId, (client) => {
          client.syncConnection?.acceptNormalizedEvent(event);
        });
      },
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
      getRuntimeIdentity: dependencies.getRuntimeIdentity,
      markRelayAttached: dependencies.markRelayAttached,
      markRelayDetached: dependencies.markRelayDetached,
      reportLog: dependencies.log,
      reportError: dependencies.reportError,
      maxClients: dependencies.maxClients,
      chatSyncProtocol: dependencies.chatSyncProtocol,
      syncHostOverrides: dependencies.syncHostOverrides,
      isMachineOffline: dependencies.isMachineOffline,
      classifyPermanentSpawnFailure: dependencies.classifyPermanentSpawnFailure,
    });
    this.legacyGenerationWatcher = new LegacyGenerationWatcher({
      registry: this.registry,
      broadcaster: this.broadcaster,
      docManager: dependencies.docManager,
      reportError: dependencies.reportError,
      reportLog: dependencies.log,
    });
    this.legacyGenerationWatcher.start();
  }
}

/** legacy 跨进程换代复核所依赖的最小宿主端口（只读连接表 + 投影广播）。 */
export interface LegacyGenerationWatcherDeps {
  readonly registry: ConnectionRegistry;
  readonly broadcaster: YjsBroadcaster;
  readonly docManager: DocManager;
  readonly reportError: (message: string, error: unknown) => void;
  readonly reportLog: (message: string) => void;
}

/**
 * 跨进程 legacy 连接失效路径。
 *
 * `replaceProjection` 只能触达本进程连接；节点 A 换代后，节点 B 的 legacy 连接仍持有旧 Doc。
 * 这里周期复核 Redis active generation，重载本地投影后以 replace 帧让客户端换代。
 * 刻意不关闭 socket：动作连接可能正在等待 `load_session` 回执，关闭会释放共享 relay 并让命令失败。
 */
export class LegacyGenerationWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly deps: LegacyGenerationWatcherDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.checkNow();
    }, LEGACY_GENERATION_WATCH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** 立即复核全部含 legacy 连接的会话（定时器与测试共用同一入口）。 */
  async checkNow(): Promise<void> {
    const sessions = new Set<string>();
    this.deps.registry.forEachClient((client) => {
      if (!client.syncOnly) sessions.add(client.rcsSessionId);
    });
    await Promise.all([...sessions].map((rcsSessionId) => this.checkSession(rcsSessionId)));
  }

  private checkSession(rcsSessionId: string): Promise<void> {
    const running = this.inflight.get(rcsSessionId);
    if (running !== undefined) return running;
    const run = this.reloadIfStale(rcsSessionId)
      .catch((error: unknown) => {
        this.deps.reportError("[YJS-FE] legacy projection generation refresh failed", error);
      })
      .finally(() => {
        if (this.inflight.get(rcsSessionId) === run) this.inflight.delete(rcsSessionId);
      });
    this.inflight.set(rcsSessionId, run);
    return run;
  }

  private async reloadIfStale(rcsSessionId: string): Promise<void> {
    const generation = this.deps.docManager.getProjectionGeneration(rcsSessionId);
    if (generation === null) return;
    if (await this.deps.docManager.isGenerationCurrent(rcsSessionId, generation)) return;
    // 旧批次的 flush 会从 map 取当前 Doc，重载前必须丢弃，否则旧会话增量写进新投影。
    this.deps.docManager.cancelACPBatch(rcsSessionId);
    const chat = await this.deps.docManager.openChat(rcsSessionId);
    const session = await this.deps.docManager.openSession("", "", rcsSessionId);
    // 并发路径可能已完成本次换代：只广播成对且确实推进了代次的结果。
    if (chat.generation === generation || chat.generation !== session.generation) return;
    const projection: ProjectionDocs = {
      rcsSessionId,
      generation: chat.generation,
      targetAcpSessionId: null,
      chat,
      session,
    };
    const chatName = `chat:${rcsSessionId}`;
    const sessionName = `session:${rcsSessionId}`;
    this.deps.broadcaster.registerYjsDocListener(chat.ydoc, chatName, projection.generation);
    this.deps.broadcaster.registerYjsDocListener(session.ydoc, sessionName, projection.generation);
    // force：动作连接不能因背压丢掉唯一的失效信号。
    this.deps.broadcaster.broadcastReplacement(chat.ydoc, chatName, projection.generation, true);
    this.deps.broadcaster.broadcastReplacement(session.ydoc, sessionName, projection.generation, true);
    this.deps.reportLog(`[YJS-FE] reloaded cross-process projection: rcsSessionId=${rcsSessionId}`);
  }
}
