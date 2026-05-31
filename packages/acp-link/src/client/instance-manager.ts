import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  buildOpencodeRuntimeConfig,
  ensureWorkspaceRuntimeDirs,
  installSkills,
  writeOpencodeConfig,
} from "@fenix/opencode";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { resolveExecutable } from "./resolve-executable";

interface InstanceState {
  instanceId: string;
  launchSpec: AgentLaunchSpec;
  workspace: string;
  process: ChildProcess | null;
  connection: acp.ClientSideConnection | null;
  capabilities: Record<string, unknown> | null;
}

/**
 * 远程实例管理器。
 * 处理 prepare（装配环境）→ start（spawn agent）→ stop（清理）的完整生命周期。
 */
export class InstanceManager {
  private instances = new Map<string, InstanceState>();
  private readonly agentName: string;
  private readonly workspaceRoot: string;

  constructor(agentName: string, workspaceRoot: string) {
    this.agentName = agentName;
    this.workspaceRoot = workspaceRoot;
  }

  async prepare(instanceId: string, launchSpec: AgentLaunchSpec): Promise<void> {
    const workspace = this.resolveWorkspace(launchSpec);

    const installedSkills = await installSkills(workspace, launchSpec.skills);
    const runtimeConfig = buildOpencodeRuntimeConfig(launchSpec, installedSkills);
    await writeOpencodeConfig(workspace, runtimeConfig);

    this.instances.set(instanceId, {
      instanceId,
      launchSpec,
      workspace,
      process: null,
      connection: null,
      capabilities: null,
    });

    console.log(`[instance-manager] prepared: ${instanceId} at ${workspace}`);
  }

  async start(instanceId: string): Promise<{ capabilities: Record<string, unknown> }> {
    const state = this.instances.get(instanceId);
    if (!state) throw new Error(`Instance ${instanceId} not prepared`);

    const opencodeExecutable = resolveExecutable(this.agentName);
    const spawnEnv = state.launchSpec.env ? { ...process.env, ...state.launchSpec.env } : { ...process.env };

    const proc = spawn(opencodeExecutable, ["acp"], {
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
        sessionUpdate: async () => {},
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

    state.process = proc;
    state.connection = connection;
    state.capabilities = (initResult.agentCapabilities as Record<string, unknown>) ?? {};

    console.log(`[instance-manager] started: ${instanceId}, capabilities:`, Object.keys(state.capabilities));

    return { capabilities: state.capabilities };
  }

  async stop(instanceId: string): Promise<void> {
    const state = this.instances.get(instanceId);
    if (!state) return;

    if (state.process && !state.process.killed) {
      state.process.kill("SIGTERM");
    }
    state.process = null;
    state.connection = null;

    this.instances.delete(instanceId);
    console.log(`[instance-manager] stopped: ${instanceId}`);
  }

  getConnection(instanceId: string): acp.ClientSideConnection | null {
    return this.instances.get(instanceId)?.connection ?? null;
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
