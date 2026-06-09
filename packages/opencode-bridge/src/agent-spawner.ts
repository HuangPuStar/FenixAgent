import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { resolveExecutable } from "../../acp-link/src/client/resolve-executable.js";

/** spawn 结果 */
export interface SpawnResult {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  capabilities: Record<string, unknown>;
}

/** spawn 配置 */
export interface SpawnConfig {
  /** 可执行文件名或路径 */
  command: string;
  /** 工作目录 */
  cwd: string;
  /** 环境变量 */
  env?: Record<string, string>;
}

/**
 * spawn opencode acp 子进程 + 建立 ACP 连接。
 * 权限策略：requestPermission → always allow（与 instance-manager.ts 一致）
 */
export async function spawnOpencodeAgent(config: SpawnConfig): Promise<SpawnResult> {
  const spawnEnv = config.env ? { ...process.env, ...config.env } : { ...process.env };

  const executable = resolveExecutable(config.command);

  const proc = spawn(executable, ["acp"], {
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "inherit"],
    env: spawnEnv,
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

  return {
    process: proc,
    connection,
    capabilities: (initResult.agentCapabilities as Record<string, unknown>) ?? {},
  };
}
