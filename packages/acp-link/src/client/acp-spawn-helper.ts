import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { ACP_METHOD, createNotification } from "../json-rpc.js";

export interface SpawnResult {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  capabilities: Record<string, unknown>;
}

/**
 * spawn ACP 子进程并初始化 ClientSideConnection。
 * opencode 和 ccb handler 共用此逻辑。
 */
export async function spawnAcpAgent(
  executable: string,
  args: string[],
  workspace: string,
  launchSpecEnv: Record<string, string> | undefined,
  send: (message: unknown) => void,
): Promise<SpawnResult> {
  const spawnEnv = launchSpecEnv ? { ...process.env, ...launchSpecEnv } : { ...process.env };

  const proc = spawn(executable, args, {
    cwd: workspace,
    stdio: ["pipe", "pipe", "inherit"],
    env: spawnEnv,
  });

  const input = Writable.toWeb(proc.stdin!) as unknown as WritableStream<Uint8Array>;
  const output = Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(
    () => ({
      requestPermission: async () => ({ outcome: { outcome: "selected" as const, optionId: "allow" } }),
      sessionUpdate: async (params: Record<string, unknown>) => {
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

  return {
    process: proc,
    connection,
    capabilities: (initResult.agentCapabilities as Record<string, unknown>) ?? {},
  };
}
