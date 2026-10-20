// packages/chat-channel/src/__tests__/sync-runtime-ingress.test.ts
// W2：实时入口适配器（`sync/runtime/ingress.ts`）的行为测试。
// 覆盖编号无洞、写者失败不推进序号、有界容量、快照不可变，以及 ACP `session/update` 各类载荷到中立事件的
// 映射与已声明的缺口行为（turn 正常结束、非文本内容块、缺轮次身份、用户消息回显）。
// 写者用最小替身（可注入单次失败）：本文件考的是入口的编号与快照契约；写者自身的合并/提交/封口行为由
// `sync-live-writer.test.ts` 在真实存储上覆盖。

import { describe, expect, test } from "bun:test";

import type { LiveInput, LiveWriter } from "../sync/live/live-writer";
import { SyncProtocolError } from "../sync/protocol/errors";
import {
  createLiveIngress,
  type LiveIngress,
  type NumberedIngressRecord,
  normalizeAcpSessionUpdate,
  type SyncIngressEvent,
} from "../sync/runtime/ingress";

const TURN = "turn-1";
const ASSISTANT_ENTRY = `${TURN}:assistant`;
const SEMANTIC_SLOT = "semantic";
const SEMANTIC_CONTENT_TYPE = "application/json";

/** 入口不调用的写者出口：抛错而不是返回空值，避免替身在无关路径上伪装成成功。 */
function unusedWriterMethod<T>(name: string): Promise<T> {
  throw new Error(`stub writer does not implement ${name}`);
}

/** 最小写者替身：记录收到的输入，允许按序注入单次失败（第 N 次 accept 抛错，之后可继续成功）。 */
class StubWriter implements LiveWriter {
  readonly inputs: LiveInput[] = [];
  private readonly pendingFailures: unknown[] = [];

  readonly acquire: LiveWriter["acquire"] = () => unusedWriterMethod("acquire");
  readonly commit: LiveWriter["commit"] = () => unusedWriterMethod("commit");
  readonly seal: LiveWriter["seal"] = () => unusedWriterMethod("seal");
  readonly rotateRuntime: LiveWriter["rotateRuntime"] = () => unusedWriterMethod("rotateRuntime");
  readonly recover: LiveWriter["recover"] = () => unusedWriterMethod("recover");
  readonly close: LiveWriter["close"] = () => unusedWriterMethod("close");

  failNext(error: unknown): void {
    this.pendingFailures.push(error);
  }

  async accept(input: LiveInput): Promise<void> {
    const failure = this.pendingFailures.shift();
    if (failure !== undefined) throw failure;
    this.inputs.push(input);
  }
}

/** 可阻塞写者替身：`block()` 后 accept 挂起，用于验证 pending 预算而非累计历史上限。 */
class GatedWriter implements LiveWriter {
  readonly inputs: LiveInput[] = [];
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  readonly acquire: LiveWriter["acquire"] = () => unusedWriterMethod("acquire");
  readonly commit: LiveWriter["commit"] = () => unusedWriterMethod("commit");
  readonly seal: LiveWriter["seal"] = () => unusedWriterMethod("seal");
  readonly rotateRuntime: LiveWriter["rotateRuntime"] = () => unusedWriterMethod("rotateRuntime");
  readonly recover: LiveWriter["recover"] = () => unusedWriterMethod("recover");
  readonly close: LiveWriter["close"] = () => unusedWriterMethod("close");

  block(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate?.();
    this.releaseGate = null;
    this.gate = null;
  }

  async accept(input: LiveInput): Promise<void> {
    this.inputs.push(input);
    const gate = this.gate;
    if (gate !== null) await gate;
  }
}

function makeIngress(
  maxRecords = 8,
  extra: { readonly maxBytes?: number; readonly diagnosticLimit?: number } = {},
): { ingress: LiveIngress; writer: StubWriter } {
  const writer = new StubWriter();
  return { ingress: createLiveIngress({ writer, maxRecords, ...extra }), writer };
}

function textEvent(delta: string): SyncIngressEvent {
  return {
    kind: "text-delta",
    turnId: TURN,
    entryId: ASSISTANT_ENTRY,
    contentSlot: "text",
    contentType: "text/plain",
    delta,
  };
}

function toolEvent(): SyncIngressEvent {
  return {
    kind: "semantic",
    turnId: TURN,
    entryId: ASSISTANT_ENTRY,
    contentSlot: SEMANTIC_SLOT,
    contentType: SEMANTIC_CONTENT_TYPE,
    semantic: { kind: "tool", payload: { entityId: "tool_1", toolCallId: "tool_1", metadata: { status: "running" } } },
  };
}

/** 运行时输入不可信：用 unknown 构造畸形事件，考的正是边界校验而不是类型系统。 */
function acceptMalformed(ingress: LiveIngress, raw: unknown): Promise<NumberedIngressRecord> {
  return ingress.accept(raw as SyncIngressEvent);
}

/** 取出协议错误：非本层错误原样上抛，避免把「类型不对」当成「校验生效」。 */
async function rejectionOf(promise: Promise<unknown>): Promise<SyncProtocolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SyncProtocolError) return error;
    throw error;
  }
  throw new Error("expected the promise to be rejected");
}

/** 同步抛出路径的同款断言：非本层错误原样上抛。 */
function rejectionOfSync(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}

/** 取出最后一条记录的语义载荷：缺失即失败，避免用非空断言把「没记下来」当成通过。 */
function requiredSemanticPayload(ingress: LiveIngress): Record<string, unknown> {
  const records = ingress.records();
  const record = records[records.length - 1];
  const semantic = record?.event.semantic;
  if (semantic === undefined) throw new Error("expected the last ingress record to carry a semantic payload");
  return semantic.payload;
}

/** ACP `session/update` 通知（真实形态：方法与载荷都在 JSON-RPC 信封内，`turnId` 由接线层补齐）。 */
function sessionUpdate(update: Record<string, unknown>, turnId: string = TURN): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "ses_1", update },
    turnId,
  };
}

function messageChunk(text: string, turnId: string = TURN): Record<string, unknown> {
  return sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, turnId);
}

/** 逐条接收规范化结果：返回入口记录，供编号与写者输入比对。 */
async function acceptNormalized(ingress: LiveIngress, raw: unknown): Promise<NumberedIngressRecord[]> {
  const records: NumberedIngressRecord[] = [];
  for (const event of normalizeAcpSessionUpdate(raw)) {
    records.push(await ingress.accept(event));
  }
  return records;
}

describe("LiveIngress 编号、容量与快照", () => {
  // 编号是 oracle 的坐标系：必须从 1 起、严格递增，且写者收到的顺序与编号一致。
  test("编号从 1 起严格递增无洞，写者收到顺序与编号一致", async () => {
    const { ingress, writer } = makeIngress();
    const first = await ingress.accept(textEvent("a"));
    const second = await ingress.accept(textEvent("b"));
    const third = await ingress.accept(toolEvent());

    expect([first.ingressSeq, second.ingressSeq, third.ingressSeq]).toEqual([1, 2, 3]);
    expect(ingress.lastIngressSeq()).toBe(3);
    expect(ingress.records().map((record) => record.ingressSeq)).toEqual([1, 2, 3]);
    expect(writer.inputs).toEqual([textEvent("a"), textEvent("b"), toolEvent()]);
  });

  // 写者失败是入口最重要的边界：序号与记录都不许动，否则 oracle 与写者输入永久错位。
  test("writer.accept 抛错时序号不推进、记录不落盘、错误原样上抛", async () => {
    const { ingress, writer } = makeIngress();
    const failure = new Error("writer rejected the input");
    writer.failNext(failure);

    await expect(ingress.accept(textEvent("a"))).rejects.toBe(failure);
    expect(ingress.lastIngressSeq()).toBe(0);
    expect(ingress.records()).toEqual([]);
    expect(writer.inputs).toEqual([]);

    const recovered = await ingress.accept(textEvent("b"));
    expect(recovered.ingressSeq).toBe(1);
    expect(writer.inputs).toEqual([textEvent("b")]);
  });

  // 失败不得留下洞：后续成功事件继续占用下一个连续编号。
  test("失败夹在成功之间时后续编号继续无洞", async () => {
    const { ingress, writer } = makeIngress();
    expect((await ingress.accept(textEvent("a"))).ingressSeq).toBe(1);
    writer.failNext(new Error("transient"));
    await expect(ingress.accept(textEvent("b"))).rejects.toThrow("transient");
    expect((await ingress.accept(textEvent("c"))).ingressSeq).toBe(2);
    expect(ingress.records().map((record) => record.event)).toEqual([textEvent("a"), textEvent("c")]);
  });

  // 并发接收必须串行编号：同一事件的两次 assign 会撞号，编号顺序也会与调用顺序不符。
  test("并发 accept 的编号与调用顺序一致", async () => {
    const { ingress, writer } = makeIngress();
    const records = await Promise.all([
      ingress.accept(textEvent("a")),
      ingress.accept(textEvent("b")),
      ingress.accept(textEvent("c")),
    ]);

    expect(records.map((record) => record.ingressSeq)).toEqual([1, 2, 3]);
    expect(writer.inputs).toEqual([textEvent("a"), textEvent("b"), textEvent("c")]);
  });

  // oracle 单位必须不可变：返回的数组与记录都不允许被外部改写。
  test("records() 返回冻结快照，外部改不动内部状态", async () => {
    const { ingress } = makeIngress();
    await ingress.accept(textEvent("a"));
    const snapshot = ingress.records();
    const record = snapshot[0];

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.event)).toBe(true);
    expect(Reflect.set(record, "ingressSeq", 99)).toBe(false);
    expect(Reflect.set(record.event, "delta", "tampered")).toBe(false);
    expect(ingress.records()).toEqual(snapshot);
    expect(ingress.lastIngressSeq()).toBe(1);
  });

  // 调用方在接收后改写自己传入的对象，不得改变已保存记录（否则 oracle 会事后漂移）。
  test("调用方事后改写传入事件与其嵌套载荷不影响已接收记录", async () => {
    const { ingress } = makeIngress();
    const metadata: Record<string, unknown> = { status: "running" };
    const event: SyncIngressEvent = {
      kind: "semantic",
      turnId: TURN,
      entryId: ASSISTANT_ENTRY,
      contentSlot: SEMANTIC_SLOT,
      contentType: SEMANTIC_CONTENT_TYPE,
      semantic: { kind: "tool", payload: { entityId: "tool_1", metadata } },
    };
    await ingress.accept(event);
    const before = ingress.records()[0].event;
    const callerPayload = event.semantic?.payload;

    metadata.status = "completed";
    if (callerPayload !== undefined) callerPayload.entityId = "tool_2";

    expect(ingress.records()[0].event).toEqual(before);
    expect(before.semantic?.payload).toEqual({ entityId: "tool_1", metadata: { status: "running" } });
  });

  // 同一载荷里同一对象被引用两次（DAG 别名）：两次出现的都必须是冻结副本，事后改写原对象两处都不受影响。
  test("载荷里同一对象被引用两次时两处都是冻结副本，改写原对象不污染快照", async () => {
    const { ingress } = makeIngress();
    const shared: Record<string, unknown> = { value: 1 };
    await ingress.accept({
      kind: "semantic",
      turnId: TURN,
      entryId: ASSISTANT_ENTRY,
      contentSlot: SEMANTIC_SLOT,
      contentType: SEMANTIC_CONTENT_TYPE,
      semantic: { kind: "tool", payload: { first: shared, second: shared, list: [shared, shared] } },
    });
    const payload = requiredSemanticPayload(ingress);

    shared.value = 2;
    // 两处引用都不允许是调用方的原对象（同一份副本或两份等价副本都可以，但不能共享引用）。
    expect(payload.first).not.toBe(shared);
    expect(payload.second).not.toBe(shared);
    expect(Object.isFrozen(payload.first)).toBe(true);
    expect(Object.isFrozen(payload.second)).toBe(true);
    expect(payload.first).toEqual({ value: 1 });
    expect(payload.second).toEqual({ value: 1 });
    expect(payload.list).toEqual([{ value: 1 }, { value: 1 }]);
  });

  // 真环（自引用）：深拷贝不得无限递归，也不得把环上的回指留成调用方的原对象。
  test("载荷含循环引用时既能拷贝也不与外部共享引用", async () => {
    const { ingress } = makeIngress();
    const node: Record<string, unknown> = { name: "node" };
    node.self = node;
    await ingress.accept({
      kind: "semantic",
      turnId: TURN,
      entryId: ASSISTANT_ENTRY,
      contentSlot: SEMANTIC_SLOT,
      contentType: SEMANTIC_CONTENT_TYPE,
      semantic: { kind: "tool", payload: { node } },
    });
    const payload = requiredSemanticPayload(ingress);
    const copied = payload.node;

    // 期望：环在副本内闭合（回指冻结副本自身），且副本不含调用方的原对象。
    expect(copied).not.toBe(node);
    expect((copied as Record<string, unknown>).self).toBe(copied);
    node.name = "tampered";
    expect((copied as Record<string, unknown>).name).toBe("node");
  });

  // 记录必须与写者实际收到的输入逐字段相等（oracle 比对的前提），且入口事件与 LiveInput 结构同构。
  test("records() 与 writer 实际收到的输入逐字段相等", async () => {
    const { ingress, writer } = makeIngress();
    const accepted = await ingress.accept(toolEvent());
    const asLiveInput: LiveInput = accepted.event;

    expect(writer.inputs).toEqual([accepted.event]);
    expect(asLiveInput.semantic?.kind).toBe("tool");
  });

  // maxRecords 现在是 pending 预算而非累计历史上限：即时写者逐条释放额度，累计接收可以无限增长。
  test("即时写者下累计接收 3000 条不受 maxRecords 限制，lastIngressSeq 持续递增", async () => {
    const { ingress, writer } = makeIngress(8);
    const total = 3000;

    for (let index = 0; index < total; index += 1) {
      const record = await ingress.accept(textEvent(`chunk-${index}`));
      if (index === 0 || index === total - 1) expect(record.ingressSeq).toBe(index + 1);
    }

    expect(ingress.lastIngressSeq()).toBe(total);
    expect(writer.inputs).toHaveLength(total);
    expect(ingress.records().map((record) => record.ingressSeq)).toEqual([
      2993, 2994, 2995, 2996, 2997, 2998, 2999, 3000,
    ]);
  });

  // 慢写者会让在飞 + 排队事件累积；额度必须在入队前预留，超限调用立即失败而不是挂到 tail 后面。
  test("慢写者阻塞时 pending 条数有界，超限 accept 立即拒绝", async () => {
    const writer = new GatedWriter();
    const ingress = createLiveIngress({ writer, maxRecords: 2, maxBytes: 1024 * 1024 });
    writer.block();

    const first = ingress.accept(textEvent("a"));
    const second = ingress.accept(textEvent("b"));
    // 写者仍阻塞时第三条就应被拒：这条 rejection 在 release 之前完成，证明没有先排队再检查。
    const error = await rejectionOf(ingress.accept(textEvent("c")));
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(error.message).toContain("pending events");
    expect(ingress.lastIngressSeq()).toBe(0);

    writer.release();
    const [firstRecord, secondRecord] = await Promise.all([first, second]);
    expect([firstRecord.ingressSeq, secondRecord.ingressSeq]).toEqual([1, 2]);
    expect(writer.inputs).toEqual([textEvent("a"), textEvent("b")]);

    // 任务完成即释放额度，后续接收恢复且编号继续无洞。
    expect((await ingress.accept(textEvent("c"))).ingressSeq).toBe(3);
  });

  // 写者失败也必须释放 pending 额度：否则一次失败会让入口在 maxRecords 很小时永久拒绝后续事件。
  test("写者失败后释放 pending 额度，后续接收不被容量拒绝", async () => {
    const { ingress, writer } = makeIngress(1);
    writer.failNext(new Error("writer boom"));

    let failure: unknown;
    try {
      await ingress.accept(textEvent("a"));
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error ? failure.message : null).toBe("writer boom");
    expect(ingress.lastIngressSeq()).toBe(0);

    // maxRecords=1：若失败路径漏掉 finally，这次调用会因 pending 仍为 1 而被容量拒绝。
    expect((await ingress.accept(textEvent("b"))).ingressSeq).toBe(1);
    expect(ingress.records().map((record) => record.event)).toEqual([textEvent("b")]);
  });

  // 字节预算同样在快照后的入队前检查：超限事件不占用 tail、不进入写者、不推进序号。
  test("pending 字节预算在入队前拒绝超限事件", async () => {
    const { ingress, writer } = makeIngress(8, { maxBytes: 64 });

    const error = await rejectionOf(ingress.accept(textEvent("x".repeat(1024))));
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(error.message).toContain("pending bytes");
    expect(ingress.lastIngressSeq()).toBe(0);
    expect(ingress.records()).toEqual([]);
    expect(writer.inputs).toEqual([]);
  });

  // 慢写者下累计的 pending 字节同样有界：预算只够一条时，第二条在写者释放前就被拒绝。
  test("慢写者阻塞时 pending 字节有界，累计超预算的 accept 立即拒绝", async () => {
    const writer = new GatedWriter();
    // 每条 textEvent 的 JSON 估算为 128B；200B 预算只够一条。
    const ingress = createLiveIngress({ writer, maxRecords: 8, maxBytes: 200 });
    writer.block();

    const first = ingress.accept(textEvent("a"));
    const error = await rejectionOf(ingress.accept(textEvent("b")));
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(error.message).toContain("pending bytes");

    writer.release();
    expect((await first).ingressSeq).toBe(1);
    expect(writer.inputs).toEqual([textEvent("a")]);
  });

  // records() 只是有界诊断窗口：更早记录被淘汰，累计进度只由 lastIngressSeq 表达。
  test("records() 只保留最近 diagnosticLimit 条，不承担全量接收历史", async () => {
    const { ingress } = makeIngress(8, { diagnosticLimit: 3 });

    for (const delta of ["a", "b", "c", "d", "e"]) await ingress.accept(textEvent(delta));

    expect(ingress.records().map((record) => record.ingressSeq)).toEqual([3, 4, 5]);
    expect(ingress.records().map((record) => record.event)).toEqual([textEvent("c"), textEvent("d"), textEvent("e")]);
    expect(ingress.lastIngressSeq()).toBe(5);
  });

  // maxRecords / maxBytes / diagnosticLimit 都是构造期容量参数：非法值按统一口径拒绝（ADMISSION_REJECTED）。
  test("maxRecords / maxBytes / diagnosticLimit 非正整数在构造期被拒", () => {
    const writer = new StubWriter();
    for (const invalid of [0, -1, 1.5, Number.NaN]) {
      expect(rejectionOfSync(() => createLiveIngress({ writer, maxRecords: invalid })).code).toBe("ADMISSION_REJECTED");
      expect(rejectionOfSync(() => createLiveIngress({ writer, maxRecords: 8, maxBytes: invalid })).code).toBe(
        "ADMISSION_REJECTED",
      );
      expect(rejectionOfSync(() => createLiveIngress({ writer, maxRecords: 8, diagnosticLimit: invalid })).code).toBe(
        "ADMISSION_REJECTED",
      );
    }
  });

  // 重置与接收共用一条顺序队列：重置后从 1 重新编号，不产生半程清空。
  test("reset() 后编号重新从 1 开始", async () => {
    const { ingress } = makeIngress();
    await ingress.accept(textEvent("a"));
    await ingress.accept(textEvent("b"));

    ingress.reset();
    const restarted = await ingress.accept(textEvent("c"));

    expect(restarted.ingressSeq).toBe(1);
    expect(ingress.lastIngressSeq()).toBe(1);
    expect(ingress.records().map((record) => record.event)).toEqual([textEvent("c")]);
  });

  // 结构校验在编号之前：畸形事件既不消耗序号也不进入写者。
  test("结构非法的事件被拒且不消耗序号", async () => {
    const { ingress, writer } = makeIngress();
    const wrongKind = { ...textEvent("a"), kind: "unknown" };
    const missingDelta = { ...textEvent("a"), delta: undefined };
    const missingSemantic = { ...toolEvent(), semantic: undefined };

    for (const malformedInput of [wrongKind, missingDelta, missingSemantic, null, [], "event"]) {
      const error = await rejectionOf(acceptMalformed(ingress, malformedInput));
      expect(error.code).toBe("MALFORMED_FRAME");
    }
    expect(ingress.lastIngressSeq()).toBe(0);
    expect(writer.inputs).toEqual([]);
  });

  // 标识校验与协议层同源（assertIdentifier）：空标识不合法，超长标识报专用错误码。
  test("标识非法的事件被拒且不消耗序号", async () => {
    const { ingress } = makeIngress();
    const emptyTurn = { ...textEvent("a"), turnId: "" };
    const oversizedEntry = { ...textEvent("a"), entryId: "e".repeat(300) };

    expect((await rejectionOf(acceptMalformed(ingress, emptyTurn))).code).toBe("MALFORMED_FRAME");
    expect((await rejectionOf(acceptMalformed(ingress, oversizedEntry))).code).toBe("IDENTIFIER_TOO_LONG");
    expect(ingress.lastIngressSeq()).toBe(0);
  });
});

describe("normalizeAcpSessionUpdate 映射", () => {
  // 正文增量：空字符串与 CRLF 必须原样保留（oracle 比对的是字节级保真，不做 trim 与换行归一）。
  test("agent_message_chunk 映射为文本增量，空字符串与 CRLF 保真", () => {
    const deltas = ["hel", "", "lo\r\n\r\n"];
    const events = deltas.flatMap((delta) => normalizeAcpSessionUpdate(messageChunk(delta)));

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.delta)).toEqual(deltas);
    expect(events[0]).toEqual({
      kind: "text-delta",
      turnId: TURN,
      entryId: ASSISTANT_ENTRY,
      contentSlot: "text",
      contentType: "text/plain",
      delta: "hel",
    });
  });

  // 兼容三种真实到达形态：内层 update 对象、JSON-RPC 通知、`{ type, payload }` 包裹。
  test("内层 update 对象与 { type, payload } 包裹格式同样可映射", () => {
    const inner = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" }, turnId: TURN };
    const wrapped = { type: "session_data", payload: messageChunk("y") };

    expect(normalizeAcpSessionUpdate(inner)[0]?.delta).toBe("x");
    expect(normalizeAcpSessionUpdate(wrapped)[0]?.delta).toBe("y");
  });

  // 工具实体身份取源标识 toolCallId：缺它就定位不到运行态实体，不得编造 id。
  test("tool_call 映射为 tool 语义实体", () => {
    const events = normalizeAcpSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool_1",
      title: "Bash",
      status: "running",
      rawInput: { command: "ls" },
      turnId: TURN,
    });

    expect(events).toEqual([
      {
        kind: "semantic",
        turnId: TURN,
        entryId: ASSISTANT_ENTRY,
        contentSlot: SEMANTIC_SLOT,
        contentType: SEMANTIC_CONTENT_TYPE,
        semantic: {
          kind: "tool",
          payload: { entityId: "tool_1", toolCallId: "tool_1", metadata: { title: "Bash", status: "running" } },
        },
      },
    ]);
  });

  // 工具终态更新同一实体；大载荷（rawOutput）外置，不写进 1KiB 的运行态元数据。
  test("tool_call_update 更新同一实体且不把 rawOutput 写进元数据", () => {
    const events = normalizeAcpSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool_1",
      status: "completed",
      rawOutput: { stdout: "ok" },
      turnId: TURN,
    });
    const semantic = events[0]?.semantic;

    expect(semantic?.kind).toBe("tool");
    expect(semantic?.payload.entityId).toBe("tool_1");
    expect(semantic?.payload.metadata).toEqual({ status: "completed" });
    expect(semantic?.payload.metadata).not.toHaveProperty("rawOutput");
  });

  // 私有结果/错误帧可能不带 status：终态必须由帧类型推断，否则实体永远 running（B06）。
  test("无 status 的私有工具结果/错误帧按帧类型收口为终态", () => {
    const completed = normalizeAcpSessionUpdate({
      sessionUpdate: "tool_call_result",
      toolCallId: "tool_1",
      turnId: TURN,
    });
    const failed = normalizeAcpSessionUpdate({
      sessionUpdate: "tool_call_error",
      toolCallId: "tool_1",
      turnId: TURN,
    });

    expect(completed[0]?.semantic?.payload).toMatchObject({ terminal: true, metadata: { status: "completed" } });
    expect(failed[0]?.semantic?.payload).toMatchObject({ terminal: true, metadata: { status: "failed" } });
  });

  // 显式 status 优先于帧类型：结果帧声明 running 时不得被错误收口，声明 failed 时仍按失败处理。
  test("显式 status 优先于帧类型推断", () => {
    const running = normalizeAcpSessionUpdate({
      sessionUpdate: "tool_call_result",
      toolCallId: "tool_1",
      status: "running",
      turnId: TURN,
    });
    const failed = normalizeAcpSessionUpdate({
      sessionUpdate: "tool_call_result",
      toolCallId: "tool_1",
      status: "failed",
      turnId: TURN,
    });

    expect(running[0]?.semantic?.payload).not.toHaveProperty("terminal");
    expect(running[0]?.semantic?.payload.metadata).toEqual({ status: "running" });
    expect(failed[0]?.semantic?.payload).toMatchObject({ terminal: true, metadata: { status: "failed" } });
  });

  // 权限请求：JSON-RPC 请求形态（method=requestPermission，params 即请求载荷）映射为 pending 实体。
  test("requestPermission 映射为 pending 权限实体", () => {
    const events = normalizeAcpSessionUpdate({
      jsonrpc: "2.0",
      id: 7,
      method: "requestPermission",
      params: {
        requestId: "perm_1",
        sessionId: "ses_1",
        options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
        toolCall: { toolCallId: "tool_1", title: "Bash" },
      },
      turnId: TURN,
    });

    expect(events).toEqual([
      {
        kind: "semantic",
        turnId: TURN,
        entryId: ASSISTANT_ENTRY,
        contentSlot: SEMANTIC_SLOT,
        contentType: SEMANTIC_CONTENT_TYPE,
        semantic: {
          kind: "permission",
          payload: { entityId: "perm_1", toolCallId: "tool_1", metadata: { status: "pending", title: "Bash" } },
        },
      },
    ]);
  });

  // 权限决议必须落在同一实体上（换 id 会让前端留下永不消失的待决权限），并带上决议值。
  test("permission_response 映射到同一权限实体并保留 decision", () => {
    const request = normalizeAcpSessionUpdate({
      sessionUpdate: "permission_request",
      permissionId: "perm_1",
      toolCallId: "tool_1",
      title: "Bash",
      turnId: TURN,
    });
    const resolved = normalizeAcpSessionUpdate({
      sessionUpdate: "permission_response",
      permissionId: "perm_1",
      optionId: "allow_once",
      turnId: TURN,
    });

    expect(request[0]?.semantic?.payload.entityId).toBe("perm_1");
    expect(resolved[0]?.semantic?.payload.entityId).toBe(request[0]?.semantic?.payload.entityId);
    expect(resolved[0]?.semantic?.payload.metadata).toEqual({ status: "resolved", decision: "allow_once" });
  });

  // 取消有两种真实到达形态（stopReason=cancelled 与 cancel 响应 { cancelled: true }），都进 cancel 屏障。
  test("取消响应映射为 cancel 屏障", () => {
    const stopped = normalizeAcpSessionUpdate({
      jsonrpc: "2.0",
      id: 3,
      result: { stopReason: "cancelled" },
      turnId: TURN,
    });
    const cancelled = normalizeAcpSessionUpdate({ jsonrpc: "2.0", id: 3, result: { cancelled: true }, turnId: TURN });

    expect(stopped[0]?.semantic).toEqual({
      kind: "cancel",
      payload: { entityId: `${TURN}:cancel`, metadata: { status: "cancelled", stopReason: "cancelled" } },
    });
    expect(cancelled[0]?.semantic?.payload.entityId).toBe(`${TURN}:cancel`);
  });

  // 失败响应进 error 屏障；原始 message 属公开错误注册表，不得写进运行态元数据。
  test("错误响应映射为 error 屏障且元数据不含原始 message", () => {
    const events = normalizeAcpSessionUpdate({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32000, message: "provider detail" },
      turnId: TURN,
    });
    const semantic = events[0]?.semantic;

    expect(semantic?.kind).toBe("error");
    expect(semantic?.payload.entityId).toBe(`${TURN}:error`);
    expect(semantic?.payload.metadata).toEqual({ status: "failed", code: -32000 });
    expect(semantic?.payload.metadata).not.toHaveProperty("message");
  });

  // 正常结束没有对应 BarrierKind：final 需要存储侧描述符，入口不产出（文件头缺口 ①）。
  test("turn 正常结束返回空数组", () => {
    expect(
      normalizeAcpSessionUpdate({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" }, turnId: TURN }),
    ).toEqual([]);
    expect(
      normalizeAcpSessionUpdate({ jsonrpc: "2.0", id: 3, result: { usage: { totalTokens: 1 } }, turnId: TURN }),
    ).toEqual([]);
  });

  // 未识别载荷一律空数组：不抛错、也不把会话级元数据塞进实时内容事件。
  test("未识别载荷返回空数组", () => {
    const unknownPayloads: unknown[] = [
      sessionUpdate({ sessionUpdate: "plan", entries: [] }),
      sessionUpdate({ sessionUpdate: "usage_update", used: 1, size: 2 }),
      { jsonrpc: "2.0", method: "session/new", result: {} },
      { type: "status", payload: { connected: true } },
      { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "..." }, turnId: TURN },
      "session/update",
      42,
      null,
      [],
    ];
    for (const payload of unknownPayloads) {
      expect(normalizeAcpSessionUpdate(payload)).toEqual([]);
    }
  });

  // 轮次身份缺口：ACP 载荷本身不带 turnId，凭空归属会把不同 prompt 的文本并进同一记录。
  test("缺 turnId 的纯 ACP 载荷不产出事件", () => {
    const withoutTurn = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses_1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
    };
    const innerWithoutTurn = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } };

    expect(normalizeAcpSessionUpdate(withoutTurn)).toEqual([]);
    expect(normalizeAcpSessionUpdate(innerWithoutTurn)).toEqual([]);
  });

  // 用户消息只由后端写入：ACP 回显再写一次会把正文写重（文件头缺口 ⑤）。
  test("user_message_chunk 不映射", () => {
    const echo = sessionUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } });
    expect(normalizeAcpSessionUpdate(echo)).toEqual([]);
  });

  // 入口不做任何合并与重排：同 entry/slot 的连续增量保持分片，槽位顺序即接收顺序。
  test("连续文本增量不在入口合并，且不跨槽位重排", async () => {
    const { ingress, writer } = makeIngress();
    await acceptNormalized(ingress, messageChunk("a"));
    await acceptNormalized(ingress, messageChunk("b"));
    const thought = sessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } });
    await acceptNormalized(ingress, thought);

    const received = writer.inputs.map((input) =>
      input.kind === "text-delta" ? [input.contentSlot, input.delta] : null,
    );
    expect(received).toEqual([
      ["text", "a"],
      ["text", "b"],
      ["reasoning", "think"],
    ]);
    expect(ingress.lastIngressSeq()).toBe(3);
  });

  // 纯函数：不改写输入，每次返回新数组（调用方拿到的不是内部共享状态）。
  test("不改写输入且每次返回新数组", () => {
    const raw = messageChunk("hi");
    const before = JSON.stringify(raw);

    const first = normalizeAcpSessionUpdate(raw);
    const second = normalizeAcpSessionUpdate(raw);

    expect(JSON.stringify(raw)).toBe(before);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
