import { type AcpServerHandle, createAcpServer } from "acp-link";
import { resolveExecutable } from "./executable";

const DEFAULT_HOST = "127.0.0.1";

export type AcpLinkProcessStatus = "starting" | "running" | "stopped" | "error";

export interface StartAcpLinkInput {
  instanceId: string;
  workspace: string;
  port: number;
  env?: Record<string, string>;
  /** Agent 类型（opencode / claude-code），传给 acp-link 选择对应 bridge */
  agentType?: string;
}

export interface ManagedAcpLinkProcess {
  instanceId: string;
  port: number;
  token: string;
  status: "running";
}

export interface AcpLinkProcessManagerDependencies {
  resolveExecutable?: (command: string) => string;
  createServer?: typeof createAcpServer;
}

interface ProcessEntry {
  handle: AcpServerHandle | null;
  port: number;
  status: AcpLinkProcessStatus;
}

/**
 * 直接在进程内启动 acp-link WS 服务器（不再 spawn 子进程）。
 */
export class AcpLinkProcessManager {
  private readonly processes = new Map<string, ProcessEntry>();
  private readonly createServer: typeof createAcpServer;
  private readonly resolveExecutableImpl: (command: string) => string;

  constructor(dependencies: AcpLinkProcessManagerDependencies = {}) {
    this.createServer = dependencies.createServer ?? createAcpServer;
    this.resolveExecutableImpl = dependencies.resolveExecutable ?? resolveExecutable;
  }

  async start(input: StartAcpLinkInput): Promise<ManagedAcpLinkProcess> {
    const opencodeExecutable = this.resolveExecutableImpl("opencode");

    const handle = this.createServer({
      port: input.port,
      host: DEFAULT_HOST,
      command: opencodeExecutable,
      args: ["acp"],
      cwd: input.workspace,
      env: input.env,
      agentType: (input.agentType as "opencode" | "ccb" | undefined) ?? "opencode",
    });

    const entry: ProcessEntry = {
      handle,
      port: input.port,
      status: "running",
    };
    this.processes.set(input.instanceId, entry);

    return {
      instanceId: input.instanceId,
      port: input.port,
      token: "",
      status: "running",
    };
  }

  async stop(instanceId: string, requireEntry = false): Promise<void> {
    const entry = this.processes.get(instanceId);
    if (!entry && requireEntry) throw new Error("Agent process entry is missing; stop cannot be confirmed");
    if (!entry || entry.status === "stopped") {
      return;
    }
    if (!entry.handle) throw new Error("Agent process handle is missing; stop cannot be confirmed");
    await entry.handle.close();
    entry.status = "stopped";
    entry.handle = null;
    // 保留已确认停止的事实，runtime 后续 hook 失败重试时不能误报 entry 丢失。
  }
}
