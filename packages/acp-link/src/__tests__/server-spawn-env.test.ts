import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { createAcpServer, type ServerConfig } from "../server.js";

/** createAcpServer 传给运行时可适配器的 websocket 回调集合。 */
interface CapturedWebsocketHandlers {
  open(ws: unknown): void;
  message(ws: unknown, raw: unknown): void;
}

/** 假 WS 客户端：只需满足 server 侧 send/close/ping/readyState 的最小约定。 */
class FakeWs {
  readyState = 1;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  ping(): void {}
}

/** 假 Agent 子进程：只提供 handleConnect 读取的标准流与生命周期钩子。 */
function createFakeProcess(): childProcess.ChildProcess {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    kill(): void {},
    on(): void {},
  } as unknown as childProcess.ChildProcess;
}

const config: ServerConfig = {
  port: 9315,
  host: "127.0.0.1",
  command: "opencode",
  args: ["acp"],
  cwd: "/tmp/acp-link-spawn-env",
  // 组装器产出的白名单：memory env + langfuse 三键 + extraEnv
  env: { USER_META_API_KEY: "meta-key", LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" },
};

interface Harness {
  handlers: CapturedWebsocketHandlers;
  spawnCalls: Array<{ options: childProcess.SpawnOptions }>;
  close(): void;
}

/** 用假 serve + 假 spawn 拉起 server，返回可直接驱动 connect 帧的 harness。 */
function createHarness(): Harness {
  let handlers: CapturedWebsocketHandlers | null = null;
  const serveSpy = spyOn(Bun, "serve").mockImplementation(((options: { websocket: CapturedWebsocketHandlers }) => {
    handlers = options.websocket;
    return { port: 0, stop: () => {}, reload: () => {} };
  }) as unknown as typeof Bun.serve);
  const spawnCalls: Harness["spawnCalls"] = [];
  spyOn(childProcess, "spawn").mockImplementation((_executable, _args, options) => {
    spawnCalls.push({ options: options ?? {} });
    return createFakeProcess();
  });

  const handle = createAcpServer(config);
  serveSpy.mockRestore();
  if (!handlers) throw new Error("createAcpServer 未向运行时适配器注册 websocket 回调");
  return { handlers, spawnCalls, close: () => handle.close() };
}

/** 驱动一次 connect 帧；initialize 会一直等待假 agent 响应，故只等 spawn 落地。 */
async function connect(harness: Harness): Promise<void> {
  const ws = new FakeWs();
  harness.handlers.open(ws);
  harness.handlers.message(ws, JSON.stringify({ type: "connect" }));
  for (let attempt = 0; attempt < 10 && harness.spawnCalls.length === 0; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  spyOn(childProcess, "spawn").mockRestore();
});

describe("acp-link server spawn 环境白名单", () => {
  // 宿主 key 与部署密钥不得随 spawn 的 env 进入第三方 Agent 进程。
  test("spawn 环境不含宿主密钥", async () => {
    const previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      RCS_API_KEYS: process.env.RCS_API_KEYS,
      RCS_SYSTEM_API_KEYS: process.env.RCS_SYSTEM_API_KEYS,
    };
    process.env.DATABASE_URL = "postgres://host/leak";
    process.env.RCS_API_KEYS = "host-api-keys";
    process.env.RCS_SYSTEM_API_KEYS = "host-system-keys";
    const harness = createHarness();
    try {
      await connect(harness);
      const env = harness.spawnCalls[0]?.options.env as NodeJS.ProcessEnv;

      expect(env).not.toHaveProperty("DATABASE_URL");
      expect(env).not.toHaveProperty("RCS_API_KEYS");
      expect(env).not.toHaveProperty("RCS_SYSTEM_API_KEYS");
    } finally {
      harness.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // launchSpec 白名单（memory env + langfuse）必须完整到达 Agent 进程，否则观测与记忆能力失效。
  test("保留 launchSpec 传入的白名单变量", async () => {
    const harness = createHarness();
    try {
      await connect(harness);
      const env = harness.spawnCalls[0]?.options.env as NodeJS.ProcessEnv;

      expect(env).toMatchObject({
        USER_META_API_KEY: "meta-key",
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
      });
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      harness.close();
    }
  });
});
