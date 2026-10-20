import { describe, expect, test } from "bun:test";
import { CommandCoordinator } from "../channel/command-coordinator";
import { ConnectionRegistry } from "../channel/connection-registry";
import { SessionChannel, type SessionConnection } from "../channel/session-channel";
import type { ActionAck, ActionError, Command } from "../channel/types";
import { getSessionInfo } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function sinks() {
  const acks: ActionAck[] = [];
  const errors: ActionError[] = [];
  return {
    acks,
    errors,
    sendAck: (ack: ActionAck) => acks.push(ack),
    sendError: (error: ActionError) => errors.push(error),
  };
}

function command(id: string, type = "list_sessions", payload: Record<string, unknown> = {}): Command {
  return { rcsSessionId: "rcs-audit", commandId: id, type, sessionId: "ses-old", payload };
}

async function channelHarness() {
  const manager = new DocManager({ acpBatchWindowMs: 0 });
  await manager.openChat("rcs-audit");
  await manager.openSession("user", "env", "rcs-audit");
  const sent: Array<{ actor: string; message: Record<string, unknown> }> = [];
  const sync: string[] = [];
  const channel = new SessionChannel({
    docManager: manager,
    replaceProjection: () => {},
    syncSessionId: (_connection, id) => {
      sync.push(id);
    },
    reportError: () => {},
  });
  let rpcId = 0;
  const connection = (actor: string): SessionConnection => ({
    userId: "user",
    agentId: "env",
    instanceId: "instance",
    rcsSessionId: "rcs-audit",
    acpSessionId: "ses-old",
    sessionLoaded: true,
    agentStatusReceived: true,
    workspacePath: `/${actor}`,
    getNextRpcId: () => ++rpcId,
    sendToRelay: (message) => {
      sent.push({ actor, message });
    },
    awaitSessionMutation: () => ({ completed: Promise.resolve(true), cancel: () => {} }),
  });
  return { channel, manager, connection, sent, sync };
}

describe("Agent 编排会话与队列回归", () => {
  // 发送成功只证明请求到达 relay，绑定必须等 Agent 对 load 的成功回执。
  test("load 回执前保持旧绑定，成功后提交新绑定", async () => {
    const h = await channelHarness();
    const receipt = deferred<boolean>();
    const sent = deferred<void>();
    const connection = h.connection("a");
    connection.awaitSessionMutation = () => ({ completed: receipt.promise, cancel: () => receipt.resolve(false) });
    connection.sendToRelay = (message) => {
      h.sent.push({ actor: "a", message });
      sent.resolve();
    };
    const sink = sinks();
    const loading = h.channel.handleAction(
      connection,
      { action: "load_session", commandId: "load", sessionId: "ses-new" },
      sink,
    );
    await sent.promise;
    expect(connection.acpSessionId).toBe("ses-old");
    expect(h.sync).toEqual([]);
    expect(sink.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    receipt.resolve(true);
    await loading;
    expect(connection.acpSessionId).toBe("ses-new");
    expect(sink.acks.at(-1)).toMatchObject({ status: "committed", sessionId: "ses-new" });
  });

  // runtime 重新连接时，相同 locator 与持久时间线不能替代当前 Agent 的 load 回执。
  test("相同持久投影仍等待当前 Agent 确认", async () => {
    const h = await channelHarness();
    const a = h.connection("restarted");
    a.sessionLoaded = false;
    getSessionInfo(h.manager.getSessionYdoc("rcs-audit")!).set("sessionId", "ses-old");
    await h.manager.registerUserMessage("rcs-audit", "persisted message");
    const receipt = deferred<boolean>();
    const sent = deferred<void>();
    a.awaitSessionMutation = () => ({ completed: receipt.promise, cancel: () => receipt.resolve(false) });
    a.sendToRelay = (message) => {
      h.sent.push({ actor: "restarted", message });
      sent.resolve();
    };
    const sink = sinks();
    const loading = h.channel.handleAction(
      a,
      { action: "load_session", commandId: "restore", sessionId: "ses-old" },
      sink,
    );
    await sent.promise;
    expect(h.sent[0]?.message.method).toBe("session/load");
    expect(a.sessionLoaded).toBe(false);
    expect(sink.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    receipt.resolve(true);
    await loading;
    expect(a.sessionLoaded).toBe(true);
    expect(sink.acks.at(-1)?.status).toBe("committed");
  });

  // locator 或旧投影只提供目标，首次输入必须等待当前 runtime 的 load 确认。
  test.each([null, "ses-old"])("未确认绑定 %s 拒绝 prompt，load 后重试成功", async (sessionId) => {
    const h = await channelHarness();
    const a = h.connection("locator");
    a.acpSessionId = sessionId;
    a.sessionLoaded = false;
    const prompt = { action: "send_prompt", commandId: "initial-prompt", content: [{ type: "text", text: "hello" }] };
    const rejected = sinks();
    await h.channel.handleAction(a, prompt, rejected);
    expect(rejected.errors[0]?.error.type).toBe("ACTION.VERSION_CONFLICT");
    expect(h.sent).toEqual([]);
    expect(h.manager.hasTimelineContent("rcs-audit")).toBe(false);
    await h.channel.handleAction(
      a,
      { action: "load_session", commandId: "confirm-load", sessionId: "ses-old" },
      sinks(),
    );
    const accepted = sinks();
    await h.channel.handleAction(a, prompt, accepted);
    expect(h.sent.map(({ message }) => message.method)).toEqual(["session/load", "session/prompt"]);
    expect(h.sent.at(-1)?.message.params).toMatchObject({ sessionId: "ses-old" });
    expect(accepted.acks.at(-1)?.status).toBe("committed");
  });

  // 多标签页切换窗口输入不能静默落入旧会话，也不能改发新会话。
  test("双标签页 load 与 prompt 交错拒绝过期输入", async () => {
    const h = await channelHarness();
    const receipt = deferred<boolean>();
    const sent = deferred<void>();
    const a = h.connection("a");
    a.awaitSessionMutation = () => ({ completed: receipt.promise, cancel: () => receipt.resolve(false) });
    a.sendToRelay = (message) => {
      h.sent.push({ actor: "a", message });
      sent.resolve();
    };
    const loading = h.channel.handleAction(
      a,
      { action: "load_session", commandId: "load", sessionId: "ses-new" },
      sinks(),
    );
    await sent.promise;
    const stale = sinks();
    const pending = h.channel.handleAction(
      h.connection("b"),
      { action: "send_prompt", commandId: "prompt-old", content: [{ type: "text", text: "旧输入" }] },
      stale,
    );
    receipt.resolve(true);
    await Promise.all([loading, pending]);
    expect(stale.errors[0]?.error.type).toBe("ACTION.VERSION_CONFLICT");
    const fresh = sinks();
    await h.channel.handleAction(
      h.connection("b"),
      { action: "send_prompt", commandId: "prompt-new", content: [] },
      fresh,
    );
    expect(h.sent.at(-1)).toMatchObject({
      actor: "b",
      message: { method: "session/prompt", params: { sessionId: "ses-new" } },
    });
  });

  // 无效动作的连接对象不得替换已经排队命令的发起者身份。
  test("无效动作不能劫持排队命令的连接上下文", async () => {
    const h = await channelHarness();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const a = h.connection("a");
    a.sendToRelay = async () => {
      entered.resolve();
      await gate.promise;
    };
    const first = h.channel.handleAction(a, { action: "list_sessions", commandId: "first" }, sinks());
    await entered.promise;
    const b = h.channel.handleAction(h.connection("b"), { action: "list_sessions", commandId: "second" }, sinks());
    await h.channel.handleAction(h.connection("invalid"), { action: "unknown", commandId: "bad" }, sinks());
    gate.resolve();
    await Promise.all([first, b]);
    expect(h.sent).toEqual([expect.objectContaining({ actor: "b" })]);
  });

  // 失败 load 不得提交绑定或使同目标重试被幂等守卫错误跳过。
  test("load 拒绝后同目标重试仍发送 RPC", async () => {
    const h = await channelHarness();
    const a = h.connection("a");
    let succeeds = false;
    a.awaitSessionMutation = () => ({ completed: Promise.resolve(succeeds), cancel: () => {} });
    const failed = sinks();
    await h.channel.handleAction(a, { action: "load_session", commandId: "load", sessionId: "ses-new" }, failed);
    expect(failed.errors[0]?.error.type).toBe("ACTION.AGENT_UNAVAILABLE");
    expect(a.acpSessionId).toBe("ses-old");
    succeeds = true;
    await h.channel.handleAction(a, { action: "load_session", commandId: "load", sessionId: "ses-new" }, sinks());
    expect(h.sent).toHaveLength(2);
    expect(a.acpSessionId).toBe("ses-new");
  });

  // dispose 关闭未执行项，重连必须等待旧执行器，旧 finally 不能删除新队列。
  test("dispose 隔离旧执行器并保留不确定命令去重", async () => {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const order: string[] = [];
    const coordinator = new CommandCoordinator({
      executeCommand: async (cmd) => {
        order.push(cmd.commandId);
        if (cmd.commandId === "first") {
          entered.resolve();
          await gate.promise;
        }
        return {};
      },
    });
    const first = coordinator.submit(command("first"), sinks());
    await entered.promise;
    const oldSink = sinks();
    const old = coordinator.submit(command("old-queued"), oldSink);
    await Promise.resolve();
    coordinator.disposeRcsSession("rcs-audit");
    const next = coordinator.submit(command("new"), sinks());
    await Promise.resolve();
    expect(order).toEqual(["first"]);
    gate.resolve();
    await Promise.all([first, old, next]);
    expect(order).toEqual(["first", "new"]);
    expect(oldSink.errors[0]?.error.type).toBe("ACTION.SESSION_NOT_FOUND");
    await coordinator.submit(command("first"), sinks());
    expect(order).toEqual(["first", "new"]);
  });

  // 会话释放必须中断回执等待，不能在重连后提交旧 load 的结果。
  test("dispose 取消 load 回执并阻止迟到绑定", async () => {
    const h = await channelHarness();
    const receipt = deferred<boolean>();
    const sent = deferred<void>();
    const a = h.connection("a");
    a.awaitSessionMutation = () => ({ completed: receipt.promise, cancel: () => receipt.resolve(false) });
    a.sendToRelay = () => sent.resolve();
    const loading = h.channel.handleAction(
      a,
      { action: "load_session", commandId: "load", sessionId: "ses-new" },
      sinks(),
    );
    await sent.promise;
    h.channel.disposeRcsSession("rcs-audit");
    await loading;
    receipt.resolve(true);
    expect(a.acpSessionId).toBe("ses-old");
    expect(h.sync).toEqual([]);
  });

  // 文本预算按 UTF-8 累计，普通输入满载时仍给取消保留两条受控容量。
  test("pending 文本的数量和字节预算覆盖取消预留及清理", () => {
    const registry = new ConnectionRegistry();
    registry.createPending("ws");
    for (let i = 0; i < 64; i++) expect(registry.bufferPending("ws", "x")).toBe(true);
    expect(registry.bufferPending("ws", "x")).toBe(false);
    expect(registry.bufferPending("ws", '{"action":"cancel"}')).toBe(true);
    expect(registry.bufferPending("ws", '{"action":"cancel"}')).toBe(true);
    expect(registry.bufferPending("ws", '{"action":"cancel"}')).toBe(false);
    registry.discardPending("ws");
    registry.createPending("ws");
    expect(registry.bufferPending("ws", "中".repeat(349_525))).toBe(true);
    expect(registry.pendingTextByteCount("ws")).toBe(1_048_575);
    expect(registry.bufferPending("ws", "中")).toBe(false);
    registry.consumePending("ws");
    expect(registry.pendingTextByteCount("ws")).toBe(0);
  });

  // 异步前置校验不能绕开准入预算形成第二条无界队列。
  test("异步校验前保留数量预算且取消使用预留容量", async () => {
    const validation = deferred<void>();
    const coordinator = new CommandCoordinator({
      maxPendingPerSession: 1,
      validateAction: () => validation.promise,
      executeCommand: async () => ({}),
    });
    const one = coordinator.submit(command("one"), sinks());
    const two = coordinator.submit(command("two"), sinks());
    const overflow = sinks();
    await coordinator.submit(command("overflow"), overflow);
    expect(overflow.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
    const cancellation = sinks();
    const cancel = coordinator.submit(command("cancel", "cancel"), cancellation);
    validation.resolve();
    await Promise.all([one, two, cancel]);
    expect(cancellation.acks.at(-1)?.status).toBe("committed");
  });
  // 断线时结果未确认须明确报 unknown；旧执行器随后确认成功则保留原始结果。
  test("在途断线重发先报结果未知，确认后返回原结果", async () => {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const coordinator = new CommandCoordinator({
      executeCommand: async () => {
        entered.resolve();
        await gate.promise;
        return { turnId: "turn-original" };
      },
    });
    const old = coordinator.submit(command("unknown"), sinks());
    await entered.promise;
    coordinator.disposeRcsSession("rcs-audit");
    const unknown = sinks();
    await coordinator.submit(command("unknown"), unknown);
    expect(unknown.acks).toEqual([]);
    expect(unknown.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
    gate.resolve();
    await old;
    const confirmed = sinks();
    await coordinator.submit(command("unknown"), confirmed);
    expect(confirmed.acks[0]).toMatchObject({ status: "duplicate", turnId: "turn-original" });
  });

  // 原命令重放应先恢复结果，不能被其自身提交推进的 projection version 遮蔽。
  test("旧 expectedVersion 重放返回 unknown 或原结果，新命令仍校验版本", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    let version = 1;
    let executions = 0;
    const coordinator = new CommandCoordinator({
      getProjectionVersion: () => version,
      executeCommand: async () => {
        executions++;
        version = 2;
        entered.resolve();
        await gate.promise;
        return { sessionId: "ses-created" };
      },
    });
    const original = { ...command("versioned"), expectedProjectionVersion: 1 };
    const running = coordinator.submit(original, sinks());
    await entered.promise;
    coordinator.disposeRcsSession("rcs-audit");
    const unknown = sinks();
    await coordinator.submit(original, unknown);
    expect(unknown.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
    gate.resolve();
    await running;
    const replay = sinks();
    await coordinator.submit(original, replay);
    expect(replay.acks[0]).toMatchObject({
      status: "duplicate",
      sessionId: "ses-created",
      committedProjectionVersion: 2,
    });
    const stale = sinks();
    await coordinator.submit({ ...original, commandId: "new-stale" }, stale);
    expect(stale.errors[0]?.error.type).toBe("ACTION.VERSION_CONFLICT");
    expect(executions).toBe(1);
  });

  // 活跃队列同样占据去重会话预算，不能通过持有执行器绕过全局上限。
  test("去重会话预算在第 257 个会话创建前拒绝", async () => {
    const gate = deferred<void>();
    const coordinator = new CommandCoordinator({
      executeCommand: async () => {
        await gate.promise;
        return {};
      },
    });
    const running: Promise<void>[] = [];
    for (let i = 0; i < 256; i++)
      running.push(coordinator.submit({ ...command("id"), rcsSessionId: `rcs-${i}` }, sinks()));
    const overflow = sinks();
    await coordinator.submit({ ...command("id"), rcsSessionId: "rcs-overflow" }, overflow);
    expect(overflow.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
    gate.resolve();
    await Promise.all(running);
    const retained = sinks();
    await coordinator.submit({ ...command("id"), rcsSessionId: "rcs-0" }, retained);
    expect(retained.acks[0]?.status).toBe("duplicate");
  });

  // 正在执行的 payload 也占据字节账，普通容量用尽不影响小型取消命令。
  test("命令 payload 总字节预算在异步等待期间仍生效", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const coordinator = new CommandCoordinator({
      maxPendingBytesPerSession: 32,
      executeCommand: async (cmd) => {
        if (cmd.commandId === "first") {
          entered.resolve();
          await gate.promise;
        }
        return {};
      },
    });
    const first = coordinator.submit(command("first", "send_prompt", { text: "x".repeat(20) }), sinks());
    await entered.promise;
    const overflow = sinks();
    await coordinator.submit(command("overflow", "send_prompt", { text: "x".repeat(20) }), overflow);
    expect(overflow.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
    const cancellation = sinks();
    const cancel = coordinator.submit(command("cancel", "cancel"), cancellation);
    gate.resolve();
    await Promise.all([first, cancel]);
    expect(cancellation.acks.at(-1)?.status).toBe("committed");
  });

  // send 失败不能留下已经加载目标的假绑定，同 commandId 重试必须真正重新发出 load。
  test("load 发送失败后仍可重试同一目标", async () => {
    const h = await channelHarness();
    const a = h.connection("a");
    let attempts = 0;
    a.sendToRelay = () => {
      if (++attempts === 1) throw new Error("relay unavailable");
    };
    const failed = sinks();
    const action = { action: "load_session", commandId: "load-send-failed", sessionId: "ses-new" };
    await h.channel.handleAction(a, action, failed);
    expect(a.acpSessionId).toBe("ses-old");
    expect(failed.errors[0]?.error.type).toBe("ACTION.AGENT_UNAVAILABLE");
    await h.channel.handleAction(a, action, sinks());
    expect(attempts).toBe(2);
    expect(a.acpSessionId).toBe("ses-new");
  });
});
