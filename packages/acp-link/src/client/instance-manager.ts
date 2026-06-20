import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  buildCcbMcpConfig,
  buildCcbRuntimeConfig,
  installSkills as ccbInstallSkills,
  writeCcbConfig,
} from "@fenix/ccb";
import { buildOpencodeRuntimeConfig, installSkills, writeOpencodeConfig } from "@fenix/opencode";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { AcpDispatcher, type AcpSessionState, createAcpSessionState } from "../acp-dispatcher.js";
import { ACP_METHOD, createNotification } from "../json-rpc.js";
import { resolveExecutable } from "./resolve-executable";
import { registerWorkspace, unregisterWorkspace } from "./workspace-registry.js";

export type AgentType = "opencode" | "ccb";

interface InstanceState {
  instanceId: string;
  launchSpec: AgentLaunchSpec;
  workspace: string;
  process: ChildProcess | null;
  connection: acp.ClientSideConnection | null;
  capabilities: Record<string, unknown> | null;
  sessionState: AcpSessionState;
  dispatcher: AcpDispatcher | null;
}

/**
 * 远程实例管理器。
 * 处理 prepare（装配环境）→ start（spawn agent）→ stop（清理）的完整生命周期。
 * 每个 instance 维护独立的 AcpSessionState + AcpDispatcher 用于 ACP 消息分发。
 */
export class InstanceManager {
  private instances = new Map<string, InstanceState>();
  private readonly agentName: string;
  private readonly agentArgs: string[];
  private readonly workspaceRoot: string;
  private readonly agentType: AgentType;

  constructor(agentName: string, workspaceRoot: string, agentArgs?: string[], agentType?: AgentType) {
    this.agentName = agentName;
    this.agentArgs = agentArgs ?? ["acp"];
    this.workspaceRoot = workspaceRoot;
    this.agentType = agentType ?? "opencode";
  }

  async prepare(instanceId: string, launchSpec: AgentLaunchSpec): Promise<void> {
    const workspace = this.resolveWorkspace(launchSpec);

    // Ensure workspace directory exists
    await mkdir(workspace, { recursive: true });

    // Register workspace mapping for file operations
    if (launchSpec.environmentId) {
      await registerWorkspace(launchSpec.environmentId, workspace);
    }

    if (this.agentType === "ccb") {
      await this.prepareCcb(workspace, launchSpec);
    } else {
      await this.prepareOpencode(workspace, launchSpec);
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
    });

    console.log(`[instance-manager] prepared: ${instanceId} at ${workspace} (type=${this.agentType})`);
  }

  private async prepareOpencode(workspace: string, launchSpec: AgentLaunchSpec): Promise<void> {
    const installedSkills = await installSkills(workspace, launchSpec.skills);
    const runtimeConfig = buildOpencodeRuntimeConfig(launchSpec, installedSkills);
    await writeOpencodeConfig(workspace, runtimeConfig);
  }

  private async prepareCcb(workspace: string, launchSpec: AgentLaunchSpec): Promise<void> {
    const installedSkills = await ccbInstallSkills(workspace, launchSpec.skills);
    const runtimeConfig = buildCcbRuntimeConfig(launchSpec, installedSkills);
    await writeCcbConfig(workspace, runtimeConfig);

    // MCP servers → .mcp.json
    const mcpConfig = buildCcbMcpConfig(launchSpec);
    if (mcpConfig) {
      const { writeCcbMcpConfig } = await import("@fenix/ccb");
      await writeCcbMcpConfig(workspace, mcpConfig);
      console.log(`[instance-manager] wrote .mcp.json with ${Object.keys(mcpConfig.mcpServers).length} servers`);
    }

    // Agent prompt → .claude/CLAUDE.md
    if (launchSpec.agent.prompt) {
      const { writeClaudeMd } = await import("@fenix/ccb");
      await writeClaudeMd(workspace, launchSpec.agent.prompt);
      console.log(`[instance-manager] wrote .claude/CLAUDE.md`);
    }
  }

  async start(
    instanceId: string,
    send: (message: unknown) => void,
  ): Promise<{ capabilities: Record<string, unknown> }> {
    const state = this.instances.get(instanceId);
    if (!state) throw new Error(`Instance ${instanceId} not prepared`);

    const opencodeExecutable = resolveExecutable(this.agentName);
    const spawnEnv = state.launchSpec.env ? { ...process.env, ...state.launchSpec.env } : { ...process.env };

    const proc = spawn(opencodeExecutable, this.agentArgs, {
      cwd: state.workspace,
      stdio: ["pipe", "pipe", "inherit"],
      env: spawnEnv,
    });

    proc.on("exit", (code) => {
      console.log(`[instance-manager] opencode exited: ${instanceId}, code=${code}`);
      const s = this.instances.get(instanceId);
      if (s) {
        s.process = null;
        s.connection = null;
      }
    });

    const input = Writable.toWeb(proc.stdin!) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const connection = new acp.ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: "selected" as const, optionId: "allow" } }),
        sessionUpdate: async (params) => {
          send(createNotification(ACP_METHOD.SESSION_UPDATE, params));
        },
        readTextFile: async () => ({ content: "" }),
        writeTextFile: async () => ({}),
      }),
      stream,
    );

    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "rcs-remote", version: "1.0.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });

    console.log(
      `[instance-manager] initialized: ${instanceId}`,
      `protocol=${initResult.protocolVersion}`,
      `loadSession=${!!initResult.agentCapabilities?.loadSession}`,
      `sessionList=${!!initResult.agentCapabilities?.sessionCapabilities?.list}`,
      `sessionResume=${!!initResult.agentCapabilities?.sessionCapabilities?.resume}`,
      `workspace=${state.workspace}`,
    );

    state.process = proc;
    state.connection = connection;
    state.capabilities = (initResult.agentCapabilities as Record<string, unknown>) ?? {};

    // 创建 dispatcher，绑定 send 回调和 session state
    state.sessionState.connection = connection;
    // 透传 SDK 返回的全部 capabilities，包括 configOptions 等未知字段
    state.sessionState.agentCapabilities = initResult.agentCapabilities ?? null;
    state.sessionState.promptCapabilities = initResult.agentCapabilities?.promptCapabilities ?? null;
    state.dispatcher = new AcpDispatcher(state.sessionState, send, state.workspace);

    console.log(`[instance-manager] started: ${instanceId}, capabilities:`, Object.keys(state.capabilities));

    return { capabilities: state.capabilities };
  }

  async stop(instanceId: string): Promise<void> {
    const state = this.instances.get(instanceId);
    if (!state) return;

    if (state.process && !state.process.killed) {
      state.process.kill("SIGTERM");
    }

    const launchSpec = state.launchSpec;
    if (launchSpec?.environmentId) {
      await unregisterWorkspace(launchSpec.environmentId).catch(() => {});
    }

    state.process = null;
    state.connection = null;
    state.dispatcher = null;

    this.instances.delete(instanceId);
    console.log(`[instance-manager] stopped: ${instanceId}`);
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

  private resolveWorkspace(launchSpec: AgentLaunchSpec): string {
    if (launchSpec.environmentId) {
      return join(this.workspaceRoot, launchSpec.organizationId, launchSpec.userId, launchSpec.environmentId);
    }
    return join(this.workspaceRoot, launchSpec.organizationId, launchSpec.userId);
  }
}
