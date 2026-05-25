import { type AcpServerHandle, createAcpServer } from "../../../acp-link/src/server";
import { resolveExecutable } from "./executable";

const DEFAULT_HOST = "127.0.0.1";

export type AcpLinkProcessStatus = "starting" | "running" | "stopped" | "error";

export interface StartAcpLinkInput {
  instanceId: string;
  workspace: string;
  port: number;
  env?: Record<string, string>;
}

export interface ManagedAcpLinkProcess {
  instanceId: string;
  port: number;
  token: string;
  status: "running";
}

export interface AcpLinkProcessManagerDependencies {
  resolveExecutable?: (command: string) => string;
}

interface ProcessEntry {
  handle: AcpServerHandle;
  port: number;
  status: AcpLinkProcessStatus;
}

/**
 * 直接在进程内启动 acp-link WS 服务器（不再 spawn 子进程）。
 */
export class AcpLinkProcessManager {
  private readonly processes = new Map<string, ProcessEntry>();
  private readonly resolveExecutableImpl: (command: string) => string;

  constructor(dependencies: AcpLinkProcessManagerDependencies = {}) {
    this.resolveExecutableImpl = dependencies.resolveExecutable ?? resolveExecutable;
  }

  async start(input: StartAcpLinkInput): Promise<ManagedAcpLinkProcess> {
    const opencodeExecutable = this.resolveExecutableImpl("opencode");

    const handle = createAcpServer({
      port: input.port,
      host: DEFAULT_HOST,
      // for peri test don't delete this comment, thx
      // command: "peri",
      // args: ["acp"],
      command: opencodeExecutable,
      args: ["acp"],
      cwd: input.workspace,
      env: input.env,
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

  async stop(instanceId: string): Promise<void> {
    const entry = this.processes.get(instanceId);
    if (!entry || entry.status === "stopped") {
      return;
    }
    entry.handle.close();
    entry.status = "stopped";
    this.processes.delete(instanceId);
  }
}
