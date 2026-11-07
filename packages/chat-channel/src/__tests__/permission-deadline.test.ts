// packages/chat-channel/src/__tests__/permission-deadline.test.ts
// P0-04 权限期限回归（投影与控制面一侧）：
// 使用真实 ACP SDK 内存管道 + 原 spawnAcpAgent / DocManager / SessionChannel，
// 验证上游 expiresAt 是投影唯一期限、30s 超时终态广播把 pending 迁移为 expired，
// 以及迟到/重复的 respond_permission 返回明确错误且不二次发送给 Agent。

import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { type SpawnResult, spawnAcpAgent } from "acp-link/client/acp-spawn-helper";
import {
  createConnection,
  createHarness,
  createSinks,
  type TestHarness,
} from "../channel/session-channel-action-test-helpers";
import type { SessionConnection } from "../channel/session-connection";
import { normalizeAcpMessage } from "../protocol/acp-channel";
import { getPendingPermissions } from "../state/chat-writer";

interface CapturedTimer {
  callback: () => void;
  timer: ReturnType<typeof setTimeout>;
}

function capturePermissionTimers(): { timers: CapturedTimer[]; restore: () => void } {
  const timers: CapturedTimer[] = [];
  const original = globalThis.setTimeout;
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms: number,
    ...args: unknown[]
  ) => {
    const timer = original(callback, ms, ...args);
    if (ms >= 29_000 && ms <= 30_000) timers.push({ callback, timer });
    return timer;
  }) as typeof setTimeout);
  return { timers, restore: () => spy.mockRestore() };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`等待超时：${label}`);
}

interface PermissionPayload {
  requestId: string;
  sessionId: string;
  expiresAt: string;
}

interface RemoteSource {
  result: SpawnResult;
  frames: Array<Record<string, unknown>>;
  requestPermission: () => Promise<{ payload: PermissionPayload; outcome: Promise<unknown> }>;
  dispose: () => void;
}

async function createRemoteSource(harness: TestHarness): Promise<RemoteSource> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
    () => ({ stdin, stdout }) as unknown as childProcess.ChildProcess,
  );
  const frames: Array<Record<string, unknown>> = [];
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
  const result = await spawnAcpAgent("fake-agent", [], "/tmp", undefined, (frame) => {
    const record = frame as Record<string, unknown>;
    frames.push(record);
    const normalized = normalizeAcpMessage(record, record.type as string | undefined);
    if (normalized) harness.docManager.processNormalizedEvent("rcs-1", normalized);
  });
  return {
    result,
    frames,
    requestPermission: async () => {
      const outcome = agent.requestPermission({
        sessionId: "ses-1",
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow_once" }],
        toolCall: { toolCallId: "tool-1", title: "Execute" },
      });
      await waitFor(() => frames.some((frame) => frame.type === "permission_request"), "permission_request");
      const frame = frames.find((candidate) => candidate.type === "permission_request")!;
      return { payload: frame.payload as PermissionPayload, outcome: outcome as Promise<unknown> };
    },
    dispose: () => {
      spawnSpy.mockRestore();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

interface AgentSink {
  connection: SessionConnection;
  sentToRelay: Array<Record<string, unknown>>;
  accepted: boolean[];
}

/** 连接层：权限响应发往 Agent 时记录 Agent 是否接受（模拟 dispatcher 回执）。 */
function createAgentSink(source: RemoteSource): AgentSink {
  const sentToRelay: Array<Record<string, unknown>> = [];
  const accepted: boolean[] = [];
  const base = createConnection();
  const connection: SessionConnection = {
    ...base.connection,
    sendToRelay: (message) => {
      const record = message as Record<string, unknown>;
      sentToRelay.push(record);
      if (record.jsonrpc === "2.0" && typeof record.id === "string" && record.result) {
        const result = record.result as { outcome: acp.RequestPermissionOutcome };
        accepted.push(source.result.resolvePermissionOutcome(record.id, result.outcome));
      }
    },
  };
  return { connection, sentToRelay, accepted };
}

async function setupTurn(harness: TestHarness): Promise<void> {
  await harness.docManager.openChat("rcs-1");
  await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
  await harness.docManager.registerUserMessage("rcs-1", "run task");
  harness.docManager.processNormalizedEvent("rcs-1", {
    type: "tool_call_started",
    update: { toolCallId: "tool-1", title: "bash" },
    content: null,
  });
}

function permissionStatus(harness: TestHarness, requestId: string): unknown {
  return getPendingPermissions(harness.docManager.getSessionYdoc("rcs-1")!).get(requestId)?.get("status");
}

function dispose(harness: TestHarness, source: RemoteSource): Promise<void> {
  harness.docManager.setPermissionRequestedHandler(null);
  harness.channel.disposeRcsSession("rcs-1");
  source.dispose();
  return harness.docManager.closeAll();
}

describe("权限期限与迟到响应（ChatChannel）", () => {
  // 29s 内响应：投影期限来自上游 expiresAt（约 30s），CAS 成功且 Agent 接受一次。
  test("期限前允许成功，投影采用上游 expiresAt", async () => {
    const clock = capturePermissionTimers();
    const harness = createHarness();
    const source = await createRemoteSource(harness);
    try {
      await setupTurn(harness);
      const startedAt = Date.now();
      const { payload, outcome } = await source.requestPermission();
      const remaining = new Date(payload.expiresAt).getTime() - Date.now();
      const projection = getPendingPermissions(harness.docManager.getSessionYdoc("rcs-1")!).get(payload.requestId);

      expect(remaining).toBeGreaterThan(29_000);
      expect(remaining).toBeLessThanOrEqual(30_000);
      expect(projection?.get("expiresAt")).toBe(payload.expiresAt);

      const sink = createAgentSink(source);
      const nowSpy = spyOn(Date, "now").mockReturnValue(startedAt + 29_000);
      try {
        await harness.channel.handleAction(
          sink.connection,
          {
            action: "respond_permission",
            commandId: "cmd-allow",
            requestId: payload.requestId,
            optionId: "allow_once",
          },
          createSinks(harness),
        );
      } finally {
        nowSpy.mockRestore();
      }

      expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed"]);
      expect(sink.sentToRelay).toHaveLength(1);
      expect(sink.accepted).toEqual([true]);
      await expect(outcome).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
      expect(permissionStatus(harness, payload.requestId)).toBe("resolved");
      expect(source.frames.some((frame) => frame.type === "permission_expired")).toBe(false);
    } finally {
      await dispose(harness, source);
      clock.restore();
    }
  });

  // 30s 超时广播 expired，投影不再是 pending；31s 点击返回明确错误且不向 Agent 二次发送。
  test("30s 超时广播 expired，31s 点击返回错误且不二次执行", async () => {
    const clock = capturePermissionTimers();
    const harness = createHarness();
    const source = await createRemoteSource(harness);
    try {
      await setupTurn(harness);
      const startedAt = Date.now();
      const { payload, outcome } = await source.requestPermission();
      expect(clock.timers.length).toBeGreaterThanOrEqual(1);

      const permissionTimer = clock.timers[0]!;
      clearTimeout(permissionTimer.timer);
      permissionTimer.callback();

      await expect(outcome).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      expect(permissionStatus(harness, payload.requestId)).toBe("expired");
      const expiredFrame = source.frames.find((frame) => frame.type === "permission_expired");
      expect(expiredFrame?.payload).toEqual({ sessionId: payload.sessionId, requestId: payload.requestId });

      const sink = createAgentSink(source);
      const nowSpy = spyOn(Date, "now").mockReturnValue(startedAt + 31_000);
      try {
        await harness.channel.handleAction(
          sink.connection,
          { action: "respond_permission", commandId: "cmd-late", requestId: payload.requestId, optionId: "allow_once" },
          createSinks(harness),
        );
        // 重复点击同样失败：命令各自只到 accepted，不出现 committed
        await harness.channel.handleAction(
          sink.connection,
          {
            action: "respond_permission",
            commandId: "cmd-late-2",
            requestId: payload.requestId,
            optionId: "allow_once",
          },
          createSinks(harness),
        );
      } finally {
        nowSpy.mockRestore();
      }

      expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "accepted"]);
      expect(harness.errorFrames.map((frame) => frame.error.type)).toEqual([
        "ACTION.INVALID_STATE",
        "ACTION.INVALID_STATE",
      ]);
      expect(sink.sentToRelay).toHaveLength(0);
      expect(sink.accepted).toHaveLength(0);
      // Agent 侧 pending 已删除：迟到响应返回 false，不会执行两次工具
      expect(
        source.result.resolvePermissionOutcome(payload.requestId, {
          outcome: "selected",
          optionId: "allow_once",
        }),
      ).toBe(false);
      expect(permissionStatus(harness, payload.requestId)).toBe("expired");
    } finally {
      await dispose(harness, source);
      clock.restore();
    }
  });

  // 重复点击（新 commandId）幂等：只有第一次提交给 Agent，第二次返回明确错误。
  test("期限前重复点击只向 Agent 提交一次", async () => {
    const clock = capturePermissionTimers();
    const harness = createHarness();
    const source = await createRemoteSource(harness);
    try {
      await setupTurn(harness);
      const { payload, outcome } = await source.requestPermission();
      const sink = createAgentSink(source);

      await harness.channel.handleAction(
        sink.connection,
        { action: "respond_permission", commandId: "cmd-first", requestId: payload.requestId, optionId: "allow_once" },
        createSinks(harness),
      );
      await harness.channel.handleAction(
        sink.connection,
        { action: "respond_permission", commandId: "cmd-second", requestId: payload.requestId, optionId: "allow_once" },
        createSinks(harness),
      );

      await expect(outcome).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
      expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed", "accepted"]);
      expect(harness.errorFrames.map((frame) => frame.error.type)).toEqual(["ACTION.INVALID_STATE"]);
      expect(sink.sentToRelay).toHaveLength(1);
      expect(sink.accepted).toEqual([true]);
    } finally {
      await dispose(harness, source);
      clock.restore();
    }
  });
});
