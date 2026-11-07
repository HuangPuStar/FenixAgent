// packages/acp-link/src/__tests__/permission-deadline.test.ts
// P0-04 权限期限回归（创建方一侧）：
// - 远端 spawn helper 与本地 acp server 都必须在 permission_request 中携带同一个
//   30s 权威 expiresAt；
// - 超时/批量取消必须广播按 requestId + sessionId 关联的 permission_expired；
// - 超时后迟到的权限响应不被接受（远端 resolvePermissionOutcome 返回 false，
//   本地 server 不再向 Agent 发送第二个响应）。

import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import * as claudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import { spawnAcpAgent } from "../client/acp-spawn-helper.js";
import { createClaudeAcpConnection } from "../client/claude-acp-adapter.js";
import { createAcpServer } from "../server.js";

interface CapturedTimer {
  callback: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 捕获权限等待的 30s 定时器，让测试可以精确触发而不等待真实时间。 */
function capturePermissionTimers(): { timers: CapturedTimer[]; restore: () => void } {
  const timers: CapturedTimer[] = [];
  const original = globalThis.setTimeout;
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms: number,
    ...args: unknown[]
  ) => {
    const timer = original(callback, ms, ...args);
    if (ms === 30_000) timers.push({ callback, timer });
    return timer;
  }) as typeof setTimeout);
  return { timers, restore: () => spy.mockRestore() };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`等待超时：${label}`);
}

function permissionPayload(frame: Record<string, unknown>): Record<string, unknown> {
  return frame.payload as Record<string, unknown>;
}

// ── 远端路径：spawnAcpAgent + 真实 ACP SDK 内存管道 ──

interface RemoteHarness {
  agent: acp.AgentSideConnection;
  sent: Array<Record<string, unknown>>;
  start: () => Promise<Awaited<ReturnType<typeof spawnAcpAgent>>>;
  dispose: () => void;
}

function createRemoteHarness(): RemoteHarness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
    () => ({ stdin, stdout }) as unknown as childProcess.ChildProcess,
  );
  const sent: Array<Record<string, unknown>> = [];
  const agent = new acp.AgentSideConnection(
    () =>
      ({
        initialize: (params: { protocolVersion: number }) => ({
          protocolVersion: params.protocolVersion,
          agentCapabilities: { loadSession: true },
          authMethods: [],
        }),
        authenticate: () => ({}),
        newSession: () => ({ sessionId: "ses-1" }),
        prompt: () => ({ stopReason: "end_turn" }),
        cancel: () => {},
      }) as never,
    acp.ndJsonStream(Writable.toWeb(stdout), Readable.toWeb(stdin)),
  );
  return {
    agent,
    sent,
    start: () =>
      spawnAcpAgent("fake-agent", [], "/tmp", undefined, (frame) => sent.push(frame as Record<string, unknown>)),
    dispose: () => {
      spawnSpy.mockRestore();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

describe("远端 spawn helper 权限期限", () => {
  // 29s 前响应：resolvePermissionOutcome 必须接受，且不广播过期终态。
  test("远端请求携带 30s expiresAt，期限前响应被 Agent 接受", async () => {
    const clock = capturePermissionTimers();
    const harness = createRemoteHarness();
    try {
      const result = await harness.start();
      const outcome = harness.agent.requestPermission({
        sessionId: "ses-1",
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow_once" }],
        toolCall: { toolCallId: "tool-1", title: "Execute" },
      });
      await waitFor(() => harness.sent.length === 1, "permission_request");
      const payload = permissionPayload(harness.sent[0]!);
      const remaining = new Date(payload.expiresAt as string).getTime() - Date.now();

      expect(remaining).toBeGreaterThan(29_000);
      expect(remaining).toBeLessThanOrEqual(30_000);
      expect(harness.sent[0]?.type).toBe("permission_request");

      expect(
        result.resolvePermissionOutcome(payload.requestId as string, {
          outcome: "selected",
          optionId: "allow_once",
        }),
      ).toBe(true);
      await expect(outcome).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
      expect(harness.sent.map((frame) => frame.type)).toEqual(["permission_request"]);
    } finally {
      harness.dispose();
      clock.restore();
    }
  });

  // 30s 超时：先广播 permission_expired（requestId + sessionId），再向 Agent 取消；迟到响应必须返回 false。
  test("远端 30s 超时广播 expired，迟到响应被拒绝", async () => {
    const clock = capturePermissionTimers();
    const harness = createRemoteHarness();
    try {
      const result = await harness.start();
      const outcome = harness.agent.requestPermission({
        sessionId: "ses-1",
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow_once" }],
        toolCall: { toolCallId: "tool-1", title: "Execute" },
      });
      await waitFor(() => harness.sent.length === 1, "permission_request");
      const payload = permissionPayload(harness.sent[0]!);
      expect(clock.timers).toHaveLength(1);

      const permissionTimer = clock.timers[0]!;
      clearTimeout(permissionTimer.timer);
      permissionTimer.callback();

      await expect(outcome).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      const expiredFrame = harness.sent.find((frame) => frame.type === "permission_expired");
      expect(expiredFrame).toBeDefined();
      expect(permissionPayload(expiredFrame!)).toEqual({
        sessionId: "ses-1",
        requestId: payload.requestId,
      });
      expect(
        result.resolvePermissionOutcome(payload.requestId as string, {
          outcome: "selected",
          optionId: "allow_once",
        }),
      ).toBe(false);
      expect(harness.sent.filter((frame) => frame.type === "permission_expired")).toHaveLength(1);
    } finally {
      harness.dispose();
      clock.restore();
    }
  });

  // relay 全部断开时的 __cancel_all__ 哨兵：每个待决请求都要留下可关联的过期终态。
  test("远端批量取消按 requestId 广播 expired", async () => {
    const clock = capturePermissionTimers();
    const harness = createRemoteHarness();
    try {
      const result = await harness.start();
      const first = harness.agent.requestPermission({
        sessionId: "ses-1",
        options: [],
        toolCall: { toolCallId: "tool-1", title: "First" },
      });
      const second = harness.agent.requestPermission({
        sessionId: "ses-2",
        options: [],
        toolCall: { toolCallId: "tool-2", title: "Second" },
      });
      await waitFor(() => harness.sent.length === 2, "two permission_request frames");

      expect(result.resolvePermissionOutcome("__cancel_all__", { outcome: "cancelled" })).toBe(true);
      await expect(first).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      await expect(second).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      const expired = harness.sent.filter((frame) => frame.type === "permission_expired").map(permissionPayload);
      expect(expired).toHaveLength(2);
      expect(expired).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: "ses-1" }),
          expect.objectContaining({ sessionId: "ses-2" }),
        ]),
      );
    } finally {
      harness.dispose();
      clock.restore();
    }
  });
});

// ── 本地路径：createAcpServer + 假 Agent 子进程 ──

interface FakeAgent {
  process: childProcess.ChildProcess;
  responses: Array<Record<string, unknown>>;
  requestPermission: (params: Record<string, unknown>) => void;
}

function createFakeAgent(): FakeAgent {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const responses: Array<Record<string, unknown>> = [];
  let input = "";
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    killed: false,
    exitCode: null as number | null,
    signalCode: null,
    kill() {
      this.killed = true;
      this.exitCode = 0;
      stdin.end();
      stdout.end();
      this.emit("exit", 0);
      return true;
    },
  });
  stdin.once("finish", () => {
    process.exitCode = 0;
    stdout.end();
    process.emit("exit", 0);
  });
  const write = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString();
    let newline = input.indexOf("\n");
    while (newline !== -1) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      newline = input.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.id === undefined) continue;
      if (message.method === "initialize") {
        write({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: { loadSession: false },
            authMethods: [],
          },
        });
      } else if (message.method === "session/new") {
        write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "ses-local" } });
      } else if (message.method === undefined) {
        responses.push(message);
      } else {
        write({ jsonrpc: "2.0", id: message.id, result: {} });
      }
    }
  });
  return {
    process: process as unknown as childProcess.ChildProcess,
    responses,
    requestPermission: (params) =>
      write({ jsonrpc: "2.0", id: "perm-request-1", method: "session/request_permission", params }),
  };
}

interface WebsocketHandlers {
  open(ws: FakeWs): void;
  message(ws: FakeWs, raw: unknown): Promise<void> | void;
  close(ws: FakeWs): void;
}

class FakeWs {
  readyState = 1;
  readonly messages: Array<Record<string, unknown>> = [];

  send(message: string): void {
    this.messages.push(JSON.parse(message) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
  }

  ping(): void {}
}

interface LocalHarness {
  handlers: WebsocketHandlers;
  ws: FakeWs;
  agent: FakeAgent;
  dispose: () => Promise<void>;
}

function createLocalHarness(): LocalHarness {
  let handlers: WebsocketHandlers | undefined;
  const serveSpy = spyOn(Bun, "serve").mockImplementation(((options: { websocket: WebsocketHandlers }) => {
    handlers = options.websocket;
    return { port: 0, stop: () => {}, reload: () => {} };
  }) as unknown as typeof Bun.serve);
  const agent = createFakeAgent();
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => agent.process);
  const handle = (() => {
    try {
      return createAcpServer({
        port: 0,
        host: "127.0.0.1",
        command: "test-agent",
        args: [],
        cwd: "/tmp/acp-permission-deadline-test",
      });
    } finally {
      serveSpy.mockRestore();
    }
  })();
  if (!handlers) throw new Error("WebSocket handlers 未注册");
  const ws = new FakeWs();
  return {
    handlers,
    ws,
    agent,
    dispose: async () => {
      await handle.close();
      spawnSpy.mockRestore();
    },
  };
}

async function sendToServer(harness: LocalHarness, message: Record<string, unknown>): Promise<void> {
  await harness.handlers.message(harness.ws, JSON.stringify(message));
}

async function openLocalSession(harness: LocalHarness): Promise<void> {
  harness.handlers.open(harness.ws);
  await sendToServer(harness, { type: "connect" });
  await sendToServer(harness, { jsonrpc: "2.0", id: "new-session", method: "session/new", params: {} });
  await waitFor(
    () => harness.ws.messages.some((message) => message.id === "new-session"),
    "local session/new response",
  );
}

function findPermissionRequest(harness: LocalHarness): Record<string, unknown> {
  const frame = harness.ws.messages.find((message) => message.type === "permission_request");
  if (!frame) throw new Error("未收到 permission_request");
  return permissionPayload(frame);
}

describe("本地 acp server 权限期限", () => {
  // 本地请求同样携带 30s expiresAt；期限前响应必须转发给 Agent。
  test("本地请求携带 30s expiresAt，期限前响应被 Agent 接受", async () => {
    const clock = capturePermissionTimers();
    const harness = createLocalHarness();
    try {
      await openLocalSession(harness);
      harness.agent.requestPermission({
        sessionId: "ses-local",
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow_once" }],
        toolCall: { toolCallId: "tool-1", title: "Execute" },
      });
      await waitFor(
        () => harness.ws.messages.some((message) => message.type === "permission_request"),
        "local permission_request",
      );
      const payload = findPermissionRequest(harness);
      const remaining = new Date(payload.expiresAt as string).getTime() - Date.now();

      expect(remaining).toBeGreaterThan(29_000);
      expect(remaining).toBeLessThanOrEqual(30_000);

      await sendToServer(harness, {
        jsonrpc: "2.0",
        id: payload.requestId,
        result: { outcome: { outcome: "selected", optionId: "allow_once" } },
      });
      await waitFor(() => harness.agent.responses.length === 1, "local agent permission response");
      expect(harness.agent.responses[0]?.result).toEqual({
        outcome: { outcome: "selected", optionId: "allow_once" },
      });
    } finally {
      await harness.dispose();
      clock.restore();
    }
  });

  // 本地 30s 超时：广播 permission_expired；迟到响应只被忽略，不能产生第二个响应。
  test("本地 30s 超时广播 expired，迟到响应不产生二次应答", async () => {
    const clock = capturePermissionTimers();
    const harness = createLocalHarness();
    try {
      await openLocalSession(harness);
      harness.agent.requestPermission({
        sessionId: "ses-local",
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow_once" }],
        toolCall: { toolCallId: "tool-1", title: "Execute" },
      });
      await waitFor(
        () => harness.ws.messages.some((message) => message.type === "permission_request"),
        "local permission_request",
      );
      const payload = findPermissionRequest(harness);
      expect(clock.timers).toHaveLength(1);

      const permissionTimer = clock.timers[0]!;
      clearTimeout(permissionTimer.timer);
      permissionTimer.callback();

      await waitFor(() => harness.agent.responses.length === 1, "timeout cancellation response");
      expect(harness.agent.responses[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
      const expiredFrame = harness.ws.messages.find((message) => message.type === "permission_expired");
      expect(expiredFrame).toBeDefined();
      expect(permissionPayload(expiredFrame!)).toEqual({
        sessionId: "ses-local",
        requestId: payload.requestId,
      });

      await sendToServer(harness, {
        jsonrpc: "2.0",
        id: payload.requestId,
        result: { outcome: { outcome: "selected", optionId: "allow_once" } },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(harness.agent.responses).toHaveLength(1);
    } finally {
      await harness.dispose();
      clock.restore();
    }
  });
});

// ── Claude Code 适配器：canUseTool 权限路径 ──

describe("Claude 适配器权限期限", () => {
  // Claude 的超时同样必须广播 expired 并拒绝工具，不能像旧实现那样静默放行。
  test("Claude 适配器 30s 超时广播 expired 并拒绝工具", async () => {
    const clock = capturePermissionTimers();
    const workspace = await mkdtemp(join(tmpdir(), "claude-permission-deadline-"));
    const sent: Array<Record<string, unknown>> = [];
    let canUseTool:
      | ((toolName: string, input: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const querySpy = spyOn(claudeAgentSdk, "query").mockImplementation((request) => {
      canUseTool = (request as unknown as { options: { canUseTool: typeof canUseTool } }).options.canUseTool;
      return {
        async streamInput() {},
        async interrupt() {},
        async *[Symbol.asyncIterator]() {},
      } as never;
    });
    try {
      const connection = createClaudeAcpConnection(workspace, "test", (message) =>
        sent.push(message as Record<string, unknown>),
      );
      const session = await connection.newSession({});
      await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "run" }] });
      expect(canUseTool).toBeDefined();

      const outcome = canUseTool!("Write", { file_path: "/tmp/safe.txt" }, {});
      await waitFor(() => sent.some((frame) => frame.type === "permission_request"), "claude permission_request");
      const payload = (sent.find((frame) => frame.type === "permission_request")?.payload ?? {}) as Record<
        string,
        unknown
      >;
      const remaining = new Date(payload.expiresAt as string).getTime() - Date.now();
      expect(remaining).toBeGreaterThan(29_000);
      expect(remaining).toBeLessThanOrEqual(30_000);

      const permissionTimer = clock.timers[clock.timers.length - 1]!;
      clearTimeout(permissionTimer.timer);
      permissionTimer.callback();

      await expect(outcome).resolves.toMatchObject({ behavior: "deny" });
      expect(sent.find((frame) => frame.type === "permission_expired")?.payload).toEqual({
        sessionId: session.sessionId,
        requestId: payload.requestId,
      });
    } finally {
      querySpy.mockRestore();
      clock.restore();
      await rm(workspace, { force: true, recursive: true });
    }
  });
});
