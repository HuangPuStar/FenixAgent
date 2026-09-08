import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { type AcpDispatcher, type AcpSessionState, createAcpSessionState } from "../acp-dispatcher.js";
import { registerWorkspace, unregisterWorkspace } from "./workspace-registry.js";

// 三种引擎类型
export type AgentType = "opencode" | "ccb" | "claude-code";

// ── EngineHandler 接口 ────────────────────────────────────────

/** 引擎 start 阶段的上下文，handler 需要写入 state 的 connection/dispatcher/process 等字段 */
export interface EngineStartContext {
  state: InstanceState;
  instanceId: string;
  /** 发送回调，已由 InstanceManager.start() 包裹 relay 信封 */
  send: (message: unknown) => void;
}

/**
 * 引擎 handler：每种引擎类型提供自己的 prepare / start / stop 实现。
 * 实现类放在各自的 plugin 包中（@fenix/opencode、@fenix/ccb、@fenix/claude-code），
 * InstanceManager 只做调度，不感知具体引擎逻辑。
 */
export interface EngineHandler {
  /** 准备 workspace 配置文件 */
  prepareWorkspace(workspace: string, launchSpec: AgentLaunchSpec): Promise<void>;
  /** 启动引擎实例，返回 capabilities */
  startInstance(ctx: EngineStartContext): Promise<{ capabilities: Record<string, unknown> }>;
  /** 停止引擎实例（可选，默认只清理 state） */
  stopInstance?(state: InstanceState): Promise<void>;
}

// ── InstanceState ─────────────────────────────────────────────

interface InstanceState {
  instanceId: string;
  launchSpec: AgentLaunchSpec;
  workspace: string;
  process: ChildProcess | null;
  connection: acp.ClientSideConnection | null;
  capabilities: Record<string, unknown> | null;
  sessionState: AcpSessionState;
  dispatcher: AcpDispatcher | null;
  agentType: AgentType;
  /** 前端 relay 连接的 sessionId，用于 relaySend 回传时匹配正确的会话 */
  sessionId: string | null;
  /** 当前 runtime fence；所有异步 stop/session 输出必须与该世代匹配。 */
  runtimeGeneration: number;
  serverEpoch: string;
}

// ── InstanceManager ───────────────────────────────────────────

/**
 * 远程实例管理器。
 * 处理 prepare（装配环境）→ start（启动引擎）→ stop（清理）的完整生命周期。
 *
 * 引擎相关逻辑通过 EngineHandler 接口委托给各 plugin 包实现，
 * InstanceManager 自身只负责实例状态管理和公共流程（workspace 创建、注册等）。
 */
export class InstanceManager {
  private instances = new Map<string, InstanceState>();
  private readonly workspaceRoot: string;
  private readonly defaultEngine: string;
  private readonly handlers: Map<string, EngineHandler>;

  /**
   * @param handlers 引擎类型 → EngineHandler 的映射，如 { opencode: ..., ccb: ..., "claude-code": ... }
   * @param workspaceRoot workspace 根目录
   * @param defaultEngine 默认引擎类型（未指定 engineType 时使用）
   */
  constructor(handlers: Record<string, EngineHandler>, workspaceRoot: string, defaultEngine = "opencode") {
    this.handlers = new Map(Object.entries(handlers));
    this.workspaceRoot = workspaceRoot;
    this.defaultEngine = defaultEngine;
  }

  private getHandler(engineType?: string): EngineHandler {
    const type = engineType ?? this.defaultEngine;
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`Unknown engine type: ${type}. Available: ${[...this.handlers.keys()].join(", ")}`);
    }
    return handler;
  }

  async prepare(
    instanceId: string,
    launchSpec: AgentLaunchSpec,
    engineType: string | undefined,
    runtimeGeneration: number,
    serverEpoch: string,
  ): Promise<void> {
    const effectiveType = (engineType ?? this.defaultEngine) as AgentType;
    const handler = this.getHandler(effectiveType);
    const workspace = this.resolveWorkspace(launchSpec);
    const existing = this.instances.get(instanceId);
    if (existing && (existing.runtimeGeneration !== runtimeGeneration || existing.serverEpoch !== serverEpoch)) {
      await this.stop(instanceId, existing.runtimeGeneration, existing.serverEpoch);
    }
    const current = this.instances.get(instanceId);

    if (current?.agentType !== undefined && current.agentType !== effectiveType) {
      throw new Error(`Cannot change engine type for running instance ${instanceId}`);
    }
    if (current?.workspace !== undefined && current.workspace !== workspace) {
      throw new Error(`Cannot change workspace for running instance ${instanceId}`);
    }

    await mkdir(workspace, { recursive: true });

    if (launchSpec.environmentId) {
      await registerWorkspace(launchSpec.environmentId, workspace);
    }

    await handler.prepareWorkspace(workspace, launchSpec);

    if (current) {
      // 在线实例刷新只替换配置快照，必须保留 process/connection/dispatcher/sessionState；
      // 否则下一条 session/new 会因 dispatcher 被清空而无法送达现有 Agent 进程。
      current.launchSpec = launchSpec;
      console.log(`[instance-manager] refreshed: ${instanceId} at ${workspace} (type=${effectiveType})`);
      return;
    }

    this.instances.set(instanceId, {
      instanceId,
      launchSpec,
      workspace,
      process: null,
      connection: null,
      capabilities: null,
      sessionState: createAcpSessionState(),
      dispatcher: null,
      agentType: effectiveType,
      sessionId: null,
      runtimeGeneration,
      serverEpoch,
    });

    console.log(`[instance-manager] prepared: ${instanceId} at ${workspace} (type=${effectiveType})`);
  }

  async start(
    instanceId: string,
    send: (message: unknown) => void,
  ): Promise<{ capabilities: Record<string, unknown> }> {
    const state = this.instances.get(instanceId);
    if (!state) throw new Error(`Instance ${instanceId} not prepared`);

    const handler = this.getHandler(state.agentType);
    return handler.startInstance({ state, instanceId, send });
  }

  async stop(instanceId: string, runtimeGeneration?: number, serverEpoch?: string): Promise<void> {
    const state = this.instances.get(instanceId);
    if (!state) return;
    if (
      runtimeGeneration !== undefined &&
      (state.runtimeGeneration !== runtimeGeneration || state.serverEpoch !== serverEpoch)
    ) {
      return;
    }

    const handler = this.handlers.get(state.agentType);
    if (handler?.stopInstance) {
      await handler.stopInstance(state);
    }

    if (state.process && !state.process.killed) {
      state.process.kill("SIGTERM");
    }

    if (state.launchSpec?.environmentId) {
      await unregisterWorkspace(state.launchSpec.environmentId).catch(() => {});
    }

    state.process = null;
    state.connection = null;
    state.dispatcher = null;

    this.instances.delete(instanceId);
    console.log(`[instance-manager] stopped: ${instanceId}`);
  }

  /** 服务 epoch 切换时停止并遗忘全部旧 runtime，完成后才允许确认 clean-slate。 */
  async cleanSlate(): Promise<void> {
    await Promise.all([...this.instances.keys()].map((instanceId) => this.stop(instanceId)));
  }

  getConnection(instanceId: string): acp.ClientSideConnection | null {
    return this.instances.get(instanceId)?.connection ?? null;
  }

  getDispatcher(instanceId: string): AcpDispatcher | null {
    return this.instances.get(instanceId)?.dispatcher ?? null;
  }

  hasInstance(instanceId: string): boolean {
    return this.instances.has(instanceId);
  }

  /** 返回当前 runtime fence，供所有 session/relay 输出绑定到所属世代。 */
  getRuntimeFence(instanceId: string): { runtimeGeneration: number; serverEpoch: string } | null {
    const state = this.instances.get(instanceId);
    return state ? { runtimeGeneration: state.runtimeGeneration, serverEpoch: state.serverEpoch } : null;
  }

  /** 更新实例对应的前端 relay sessionId，使 relaySend 回传时使用正确的会话标识 */
  setSessionId(instanceId: string, sessionId: string): void {
    const state = this.instances.get(instanceId);
    if (state) {
      state.sessionId = sessionId;
    }
  }

  /** 读取实例对应的前端 relay sessionId */
  getSessionId(instanceId: string): string | null {
    return this.instances.get(instanceId)?.sessionId ?? null;
  }

  private resolveWorkspace(launchSpec: AgentLaunchSpec): string {
    if (launchSpec.environmentId) {
      return join(this.workspaceRoot, launchSpec.organizationId, launchSpec.userId, launchSpec.environmentId);
    }
    return join(this.workspaceRoot, launchSpec.organizationId, launchSpec.userId);
  }
}
