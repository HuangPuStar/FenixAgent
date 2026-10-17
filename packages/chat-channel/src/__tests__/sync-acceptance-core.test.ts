// packages/chat-channel/src/__tests__/sync-acceptance-core.test.ts
// A 交付：设计 §15.2 场景矩阵 **T01–T12** 的核心路径验收。
//
// 端到端口径（wiring spec §2.2）：服务端是真实 `createSyncScopeRuntime`（真实 store / live / provider / egress），
// 客户端是真实 `createSyncClientTransport` + `DocHub`，两端经进程内 `SyncFrameTransport` 端口相连，
// 线上字节真实经过 `encodeSyncFrame` / `decodeSyncFrame`。除假时钟（`ManualClock`）与传输端口外无替身，
// 用例只推进假时钟、不等真实墙钟。
//
// oracle 独立性（设计 §15.1）：期望值全部来自本目录的 `sync-acceptance-core-oracle.ts`——历史侧是输入对象的
// 规范化 JSON 期望，实时侧是我自己记录的事件序列；**不复用被测的分片 / 拼接 / 投影 / 合并实现**。
// 内容观测面：服务端 = store 的已提交边界重建；客户端 = 收到的数据帧字节镜像（DocHub 无内容读出口，见交货报告）。
//
// 覆盖边界（设计 §15.1 末条）：空字符串、CRLF、相同内容多条消息、代理对跨输入边界、孤立代理项。
// 覆盖不到的 T13 24h / T16 新旧切换 / T23 磁盘满 / 持久化分支（Redis + PostgreSQL）依赖真实时长与宿主适配器，
// 不在本文件；逐条结论见交货报告。

import { afterEach, describe, expect, test } from "bun:test";

import { LIVE_WRITER_LEASE_TTL_MS } from "../sync/live/live-writer";
import { SyncProtocolError } from "../sync/protocol/errors";
import { normalizeAcpSessionUpdate, type SyncIngressEvent } from "../sync/runtime/ingress";
import {
  byteDifference,
  type CoreHarness,
  type CoreHarnessOptions,
  createCoreHarness,
  decodePayload,
  joinPayloadText,
  liveText,
} from "./sync-acceptance-core-oracle";

const harnesses: CoreHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.destroy()));
});

async function open(options?: CoreHarnessOptions): Promise<CoreHarness> {
  const harness = await createCoreHarness(options);
  harnesses.push(harness);
  return harness;
}

const TEXT_SLOT = "text";
/** 设计 §10.2：单内容块的编码状态硬限（`capacity.inputs.historyBlockHardBytes`）。 */
const BLOCK_HARD_BYTES = 262144;
/** 设计 §10.2：历史入口的单对象大帧阈值（`capacity.inputs.largeFrameThresholdBytes`）。 */
const LARGE_FRAME_THRESHOLD_BYTES = 1048576;
/** 运行态实体上限（`RUNTIME_DOC_LIMITS.maxEntities`）。 */
const RUNTIME_MAX_ENTITIES = 256;

/** 取同步协议错误的码；非协议错误直接抛出，避免把未知异常当成预期结果。 */
function errorCode(error: unknown): string {
  if (error instanceof SyncProtocolError) return error.code;
  throw error;
}

/** 必需项：缺失时立刻失败，代替非空断言。 */
function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`expected ${field} to be present`);
  return value;
}

/** 断言一段动作以指定协议码失败。 */
async function expectCode(action: () => Promise<unknown>, expected: string): Promise<void> {
  let code: string | null = null;
  try {
    await action();
  } catch (error) {
    code = errorCode(error);
  }
  expect(code).toBe(expected);
}

/** 我自己的切片：按 UTF-16 索引硬切，允许把代理对切在两片之间（不做 UTF-8 边界对齐）。 */
function splitEvery(text: string, partUnits: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length; start += partUnits) {
    parts.push(text.slice(start, start + partUnits));
  }
  return parts;
}

/** 服务端已提交边界与客户端镜像的同一 entry/slot 文本必须逐字符一致；返回该文本供 oracle 比对。 */
async function textOfBothSides(
  harness: CoreHarness,
  docId: string,
  entryId: string,
  contentSlot: string,
): Promise<string> {
  const server = liveText(await harness.canonicalRecords(docId), entryId, contentSlot);
  const client = liveText(harness.mirror.readRecords(docId), entryId, contentSlot);
  expect(client).toBe(server);
  return server;
}

/** 实时正文的 oracle：每个 entry/slot 的读数必须等于我按接收顺序记录的增量拼接。 */
async function expectLiveTextMatchesLog(harness: CoreHarness, docIds: readonly string[]): Promise<void> {
  const records = (await Promise.all(docIds.map((docId) => harness.canonicalRecords(docId)))).flat();
  for (const key of harness.log.textKeys()) {
    expect(liveText(records, key.entryId, key.contentSlot)).toBe(harness.log.textFor(key.entryId, key.contentSlot));
  }
}

/** 单位块：长度固定、含代码围栏与 CRLF，用来把 10MiB 正文切成可预期的多块数据集。 */
const MARKDOWN_UNIT = "## 章节\n\n```ts\nconst answer = 42;\n```\n\n段落 😀 与 CRLF\r\n";

// ------------------------------------------------------------------ T01

describe("T01 空会话正常一轮", () => {
  // 空会话跑通完整顺序：HELLO→MANIFEST→SUBSCRIBE→DOC_BASE→(processed 回执)→BASE_READY，
  // 且客户端交付内容与 store 已提交边界逐字节一致；工具与权限实体落在运行态 Doc 上。
  test("握手到基线建立的全顺序、内容一致、工具与权限齐全", async () => {
    const harness = await open();
    await harness.handshake();

    expect(harness.controlFrames.map((frame) => frame.type)).toEqual(["HELLO", "MANIFEST"]);
    await harness.subscribe([harness.seedContentDocId, harness.seedRuntimeDocId]);

    const acks = harness.frames.filter(
      (record) => record.direction === "client-to-server" && record.frame.type === "APPLY_ACK",
    );
    expect(acks.length).toBeGreaterThanOrEqual(1);
    expect(harness.fatal).toEqual([]);

    await harness.writeSemantic("tool", { entityId: "tool-1", toolCallId: "call-1" });
    await harness.writeSemantic("permission", { entityId: "perm-1" });
    await harness.writeText("hello");

    // 服务端已提交边界与客户端镜像必须是同一份内容。
    expect(await textOfBothSides(harness, harness.seedContentDocId, "turn-1:assistant", TEXT_SLOT)).toBe("hello");

    // 运行态实体的观测面是 `doc.getMap("runtime")` 实体表（不是扁平记录表）。
    const runtimeEntities = await harness.canonicalEntities(harness.seedRuntimeDocId);
    expect(runtimeEntities.map((entity) => `${entity.entityId}:${entity.kind}`).sort()).toEqual([
      "perm-1:permission",
      "tool-1:tool",
    ]);
    // 客户端镜像收到的运行态实体必须是服务端那份（订阅里含运行态 Doc）。
    expect(harness.mirrorEntities(harness.seedRuntimeDocId)).toEqual(runtimeEntities);
  });

  // 空字符串是最小内容边界：它不产生任何记录（空增量不合并、不起算），也不改变已交付文本。
  test("空 delta 不产生记录", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId]);

    await harness.writeText("");
    await harness.writeText("A");
    await harness.writeText("");

    const records = await harness.canonicalRecords(harness.seedContentDocId);
    expect(liveText(records, "turn-1:assistant", TEXT_SLOT)).toBe("A");
    expect(records.filter((record) => record.kind === "text").length).toBe(1);
  });

  // 用户消息只由后端写入：入口不得把 `user_message_chunk` 映射成事件，否则同一 entry 会被写第二遍。
  test("用户消息回显不被入口双写", async () => {
    const harness = await open();
    const raw = {
      sessionUpdate: "user_message_chunk",
      turnId: "turn-1",
      content: { type: "text", text: "用户输入" },
    };

    expect(normalizeAcpSessionUpdate(raw)).toEqual([]);
    expect(harness.log.all).toEqual([]);
  });

  // 空会话只登记入口声明的 Doc：MANIFEST 的三个入口必须与代次登记一致，客户端据此知道该订阅什么。
  test("MANIFEST 入口与代次登记一致且不创建多余 Doc", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId, harness.seedRuntimeDocId]);

    const manifest = harness.controlFrames.find((frame) => frame.type === "MANIFEST");
    if (manifest?.type !== "MANIFEST") throw new Error("MANIFEST frame was not delivered");
    expect({
      generation: manifest.generation,
      controlDocId: manifest.controlDocId,
      runtimeDocId: manifest.runtimeDocId,
      directoryDocId: manifest.directoryDocId,
    }).toEqual({
      generation: harness.seedGeneration,
      controlDocId: harness.seedEntryRefs.controlDocId,
      runtimeDocId: harness.seedEntryRefs.runtimeDocId,
      directoryDocId: harness.seedEntryRefs.directoryDocId,
    });
    // 存储里的当前代次入口与 MANIFEST 同源（客户端声明的 Doc 必须能被服务端解析）。
    expect(await harness.currentEntryRefs()).toEqual(harness.seedEntryRefs);
    // 修订号由存储背书且从 1 起：客户端靠它挡住在途的旧控制帧。
    expect(manifest.pointerRevision).toBeGreaterThanOrEqual(1);
    expect(
      harness
        .allDocs()
        .map((row) => `${row.kind}:${row.state}`)
        .sort(),
    ).toEqual(["content:active", "runtime:active"]);
  });
});

// ------------------------------------------------------------------ T02

describe("T02 稳定历史对象零间隔突发", () => {
  // 20,000 个完整对象零间隔接收后，对象数、接收顺序与每个对象的字段/类型都必须与输入逐条一致。
  // 本用例同时是**缺陷 D2** 的复现场景：接收边界本身编号连续（下面的 `jumps` 断言为真），
  // 但分组构建只提交了「装得下 256KiB 硬限的前缀」，组内剩余记录没有成块，
  // `listDirectory` 因而报出序号码缺口，`assertComplete` 以 IMPORT_INCOMPLETE 终止导入。
  test("两万个对象暴发后顺序与内容完全一致", async () => {
    const harness = await open();
    const expected = Array.from({ length: 20_000 }, (_, index) => ({ index, text: `对象 ${index}` }));

    const started = await harness.beginImport();
    const ordinals: number[] = [];
    for (const value of expected) {
      const ingested = await harness.acceptHistory(value, { kind: "history_object", entryId: `entry-${value.index}` });
      ordinals.push(ingested.sourceOrdinal);
    }
    // 接收边界：编号从 1 起、严格递增、无洞（oracle 的实时/历史单位都靠它对齐）。
    const jumps = ordinals.filter((ordinal, index) => ordinal !== index + 1);
    expect(jumps).toEqual([]);
    expect(harness.importStatus()?.receivedOrdinal).toBe(expected.length);

    const failure = await harness.finishImport().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeNull();

    const records = await harness.flatRecords();
    expect(records.length).toBe(expected.length);
    expect(records.map((record) => record.entryId)).toEqual(expected.map((value) => `entry-${value.index}`));
    // oracle：逐条 JSON.parse 后与输入对象深比较（不复用被测的保真序列化器）。
    expect(records.map((record) => JSON.parse(decodePayload(record.payload)))).toEqual(expected);
    expect(harness.importStatus()?.gaps).toEqual([]);
    expect(await harness.currentGeneration()).toBe(started.generation);
  });

  // 接收阶段只写暂存、不提交任何块；分块构建才提交，且每块编码状态受 256KiB 硬限约束。
  test("接收阶段不提交块且提交后每块受字节硬限约束", async () => {
    const harness = await open();
    const count = 400;

    await harness.beginImport();
    for (let index = 0; index < count; index += 1) {
      await harness.acceptHistoryText(`字符 ${index} 的内容`, { entryId: `entry-${index}` });
    }
    expect(harness.docsOfKind("content").length).toBe(1);
    expect(harness.importStatus()?.committedBlocks).toBe(0);

    await harness.finishImport();
    const blocks = await harness.blocks();
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    // 目录的 ordinal 覆盖必须连续：缺口检测据此判定完整性。
    let nextOrdinal = 1;
    for (const block of blocks) {
      expect(block.ordinalStart).toBe(nextOrdinal);
      expect(block.ordinalEnd).toBe(nextOrdinal + block.records.length - 1);
      nextOrdinal = (block.ordinalEnd ?? 0) + 1;
      expect((await harness.canonicalBytes(block.docId)).byteLength).toBeLessThanOrEqual(BLOCK_HARD_BYTES);
    }
    expect(nextOrdinal - 1).toBe(count);
    expect(harness.importStatus()?.gaps).toEqual([]);
  });
});

// ------------------------------------------------------------------ T03

describe("T03 大量小对象与少数巨型对象混合", () => {
  // 巨型对象把字节预算撑开后，小对象仍逐条保真，且没有块越过编码硬限。
  test("小对象与巨型对象混合时字节预算有效", async () => {
    const harness = await open();
    const giant = "巨型文本块\n".repeat(12_000);

    await harness.beginImport();
    for (let index = 0; index < 64; index += 1) {
      await harness.acceptHistory(
        { index, text: `小对象 ${index}` },
        { kind: "history_object", entryId: `s-${index}` },
      );
    }
    await harness.acceptHistoryText(giant, { entryId: "giant-0", contentSlot: 0, partIndex: 0 });
    await harness.acceptHistoryText(giant, { entryId: "giant-1", contentSlot: 0, partIndex: 0 });
    await harness.finishImport();

    const records = await harness.flatRecords();
    expect(records.filter((record) => record.entryId.startsWith("s-")).length).toBe(64);
    expect(joinPayloadText(records, "giant-0", 0)).toBe(giant);
    expect(joinPayloadText(records, "giant-1", 0)).toBe(giant);
    for (const block of await harness.blocks()) {
      expect((await harness.canonicalBytes(block.docId)).byteLength).toBeLessThanOrEqual(BLOCK_HARD_BYTES);
    }
  });

  // 单条记录放不进空的 256KiB 块时，构建期必须给出一次明确的容量错误，且不得切换代次。
  test("单条超过块硬限时明确失败且不切换代次", async () => {
    const harness = await open();
    const before = await harness.currentGeneration();
    const docsBefore = harness.allDocs().length;

    await harness.beginImport();
    await harness.acceptHistoryText("x".repeat(BLOCK_HARD_BYTES + 40 * 1024), { entryId: "huge-0" });
    await expectCode(() => harness.finishImport(), "CAPACITY_EXCEEDED");

    expect(harness.importStatus()?.state).toBe("failed");
    expect(harness.importStatus()?.failure?.code).toBe("CAPACITY_EXCEEDED");
    expect(await harness.currentGeneration()).toBe(before);
    expect(harness.allDocs().length).toBe(docsBefore);
  });

  // 超过单对象大帧阈值的历史对象在接收期就被拒：入口没有注入 `frameParse` 额度，明确失败而非静默截断。
  test("单条超过大帧阈值时接收期明确拒绝且无部分提交", async () => {
    const harness = await open();
    const before = await harness.currentGeneration();
    const docsBefore = harness.allDocs().length;

    await harness.beginImport();
    await expectCode(
      () => harness.acceptHistoryText("x".repeat(LARGE_FRAME_THRESHOLD_BYTES + 1), { entryId: "huge-1" }),
      "ADMISSION_REJECTED",
    );

    expect(harness.importStatus()?.state).toBe("failed");
    expect(await harness.currentGeneration()).toBe(before);
    expect(harness.allDocs().length).toBe(docsBefore);
  });
});

// ------------------------------------------------------------------ T04

describe("T04 长文本跨块与编码边界", () => {
  // 10MiB Markdown 切成 64KiB 分片（切点落在代码围栏中间）后，逐条 JSON.parse 再按 partIndex 拼接必须与原文完全相同。
  test("10MiB 正文跨代码围栏切分后拼接完全相同", async () => {
    const harness = await open();
    const source = MARKDOWN_UNIT.repeat(Math.ceil((10 * 1024 * 1024) / MARKDOWN_UNIT.length)).slice(
      0,
      10 * 1024 * 1024,
    );
    const parts = splitEvery(source, 64 * 1024);

    await harness.beginImport();
    for (const [index, part] of parts.entries()) {
      await harness.acceptHistoryText(part, { entryId: "md", contentSlot: 0, partIndex: index });
    }
    await harness.finishImport();

    const records = await harness.flatRecords();
    expect(records.filter((record) => record.entryId === "md").length).toBe(parts.length);
    expect(joinPayloadText(records, "md", 0)).toBe(source);
    // 同一条逻辑消息必须能跨多个物理块，且块边界不改变它的身份与内容。
    const carriers = (await harness.blocks()).filter((block) =>
      block.records.some((record) => record.entryId === "md"),
    );
    expect(carriers.length).toBeGreaterThan(1);
  });

  // 切点落在代理对中间（JS 字符串按 UTF-16 索引切开一个字符）：两个分片各自携带一个孤立代理码元，
  // 拼接后必须还原成原来的单个字符，不出现替换字符或错位。
  test("切点落在代理对中间时分片不改变字符", async () => {
    const harness = await open();
    const source = "前😀后𝄞";
    const head = source.slice(0, 2);
    const tail = source.slice(2);
    expect(head + tail).toBe(source);

    await harness.beginImport();
    await harness.acceptHistoryText(head, { entryId: "split", contentSlot: 0, partIndex: 0 });
    await harness.acceptHistoryText(tail, { entryId: "split", contentSlot: 0, partIndex: 1 });
    await harness.finishImport();

    expect(joinPayloadText(await harness.flatRecords(), "split", 0)).toBe(source);
  });

  // 孤立代理项（源里本就不成对）：历史对象与文本分片都必须原样保留，不得被替换成 U+FFFD。
  test("孤立代理项在历史路径上原样保留", async () => {
    const harness = await open();
    const loneHigh = "a\ud83db";
    const loneLow = "c\udc00d";

    await harness.beginImport();
    await harness.acceptHistory(loneHigh, { kind: "history_object", entryId: "lone-high" });
    await harness.acceptHistory(loneLow, { kind: "history_object", entryId: "lone-low" });
    await harness.acceptHistoryText(loneHigh, { entryId: "lone-split", contentSlot: 0, partIndex: 0 });
    await harness.acceptHistoryText(loneHigh.slice(0, 2), { entryId: "lone-split", contentSlot: 0, partIndex: 1 });
    await harness.finishImport();

    const records = await harness.flatRecords();
    const values = new Map(
      records.map((record) => [record.entryId, JSON.parse(decodePayload(record.payload)) as unknown]),
    );
    expect(values.get("lone-high")).toBe(loneHigh);
    expect(values.get("lone-low")).toBe(loneLow);
    expect(joinPayloadText(records, "lone-split", 0)).toBe(`${loneHigh}${loneHigh.slice(0, 2)}`);
  });

  // 实时路径的正文载荷是裸 UTF-8 字节：孤立代理项在 UTF-8 里没有表示，落地形态是替换字符。
  // 本用例固定「两端一致 + 与编译期编码约定相同」，把与历史路径的差异显式记为观测事实（见交货报告）。
  test("孤立代理项在实时路径上两端一致且等于 UTF-8 可达形态", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId]);

    const lone = "a\ud83db";
    await harness.writeText(lone);

    const reached = new TextDecoder().decode(new TextEncoder().encode(lone));
    expect(reached).not.toBe(lone);
    expect(await textOfBothSides(harness, harness.seedContentDocId, "turn-1:assistant", TEXT_SLOT)).toBe(reached);
  });

  // CRLF 是内容不是格式控制：禁止被规范化成 LF，否则正文与源不相等。
  test("CRLF 原样保留", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId]);

    await harness.writeText("line1\r\nline2\r\n");

    expect(await textOfBothSides(harness, harness.seedContentDocId, "turn-1:assistant", TEXT_SLOT)).toBe(
      "line1\r\nline2\r\n",
    );
  });

  // 相同内容的多条消息不得被去重：不同 entry 各有一条完整记录，同一 entry 的重复文本各占一条。
  test("相同内容的多条消息与重复文本都保留", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId]);

    await harness.writeText("same", { turnId: "turn-1", entryId: "turn-1:assistant" });
    await harness.writeText("same", { turnId: "turn-2", entryId: "turn-2:assistant" });
    await harness.writeText("same", { turnId: "turn-1", entryId: "turn-1:assistant" });

    const records = await harness.canonicalRecords(harness.seedContentDocId);
    expect(liveText(records, "turn-1:assistant", TEXT_SLOT)).toBe("samesame");
    expect(liveText(records, "turn-2:assistant", TEXT_SLOT)).toBe("same");
    expect(records.filter((record) => record.kind === "text").length).toBe(3);
  });

  // 代理对在同一增量内是完整字符：这条是对照组，证明孤立代理只出现在跨编码边界处。
  test("同一增量内的代理对完整保留", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId]);

    await harness.writeText("a😀b");

    const records = await harness.canonicalRecords(harness.seedContentDocId);
    expect(liveText(records, "turn-1:assistant", TEXT_SLOT)).toBe("a😀b");
  });
});

// ------------------------------------------------------------------ T05

describe("T05 多工具并行、乱序完成与长期等待", () => {
  // 同一轮内多个工具并行开始、乱序完成：每个工具的身份唯一，终态描述符先落内容块再移出运行态。
  test("多工具并行与乱序完成不重复不丢失", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId, harness.seedRuntimeDocId]);

    const tools = ["call-a", "call-b", "call-c", "call-d"];
    for (const toolCallId of tools) {
      await harness.writeSemantic("tool", { entityId: toolCallId, toolCallId, metadata: { status: "running" } });
    }
    expect((await harness.canonicalEntities()).map((entity) => `${entity.entityId}/${entity.state}`)).toEqual([
      "call-a/open",
      "call-b/open",
      "call-c/open",
      "call-d/open",
    ]);

    for (const toolCallId of [...tools].reverse()) {
      await harness.writeSemantic("final", {
        entityId: toolCallId,
        finalDescriptor: {
          kind: "tool",
          contentRef: `blob/${toolCallId}`,
          digest: `digest-${toolCallId}`,
          byteLength: 11,
          completedAt: harness.time.now(),
        },
      });
    }

    // 终态实体在同一批次里被移出运行态：运行态只保留未结束实体。
    expect(await harness.canonicalEntities()).toEqual([]);
    const descriptors = (await harness.canonicalRecords(harness.seedContentDocId))
      .filter((record) => record.kind === "final")
      .map((record) => JSON.parse(decodePayload(record.payload)) as { entityId: string; contentRef: string });
    expect(descriptors.map((descriptor) => `${descriptor.entityId}:${descriptor.contentRef}`).sort()).toEqual(
      tools.map((toolCallId) => `${toolCallId}:blob/${toolCallId}`),
    );
    // 客户端镜像与服务端在两条路径上都一致。
    expect(harness.mirrorEntities()).toEqual([]);
    expect((await harness.canonicalEntities()).length).toBe(0);
  });

  // 长期等待权限（用户不决议）不阻塞正文封口：正文继续成记录，运行态只留那一个未结束实体。
  test("长期等待的权限不阻塞正文且不残留终态实体", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId, harness.seedRuntimeDocId]);

    await harness.writeSemantic("permission", { entityId: "perm-wait", toolCallId: "call-a" });
    await harness.writeText("正文继续写入");
    expect((await harness.canonicalEntities()).map((entity) => `${entity.entityId}/${entity.state}`)).toEqual([
      "perm-wait/open",
    ]);
    expect(await textOfBothSides(harness, harness.seedContentDocId, "turn-1:assistant", TEXT_SLOT)).toBe(
      "正文继续写入",
    );

    await harness.writeSemantic("permission", {
      entityId: "perm-wait",
      finalDescriptor: {
        kind: "permission",
        contentRef: "blob/perm-wait",
        digest: "digest-perm-wait",
        byteLength: 7,
        completedAt: harness.time.now(),
      },
    });
    expect(await harness.canonicalEntities()).toEqual([]);
  });

  // 未结束实体数量上限：第 257 个实体必须立刻报容量错误，而已落地的实体一个不少也不重复。
  test("未结束实体达到上限时明确报容量错误", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedRuntimeDocId]);

    for (let index = 0; index < RUNTIME_MAX_ENTITIES; index += 1) {
      await harness.writeSemantic("tool", { entityId: `tool-${index}`, toolCallId: `call-${index}` });
    }
    const filled = await harness.canonicalEntities();
    expect(filled.length).toBe(RUNTIME_MAX_ENTITIES);

    await expectCode(() => harness.writeSemantic("tool", { entityId: "tool-over" }), "CAPACITY_EXCEEDED");

    const after = await harness.canonicalEntities();
    expect(after.length).toBe(RUNTIME_MAX_ENTITIES);
    expect(after.some((entity) => entity.entityId === "tool-over")).toBe(false);
    expect(after.map((entity) => entity.entityId)).toEqual(filled.map((entity) => entity.entityId));
  });

  // 运行态到达事务上限时轮换：旧块封口，未结束实体被复制到新块（不消失、不重复），旧块不再可写。
  test("运行态轮换把未结束实体交接到新块", async () => {
    const harness = await open({ rotation: { maxTransactions: 2, maxResidentMs: 3_600_000 } });
    await harness.handshake();
    await harness.subscribe([harness.seedRuntimeDocId]);

    await harness.writeSemantic("tool", { entityId: "tool-a", toolCallId: "call-a" });
    await harness.writeSemantic("permission", { entityId: "perm-a" });
    expect(harness.docsOfKind("runtime").length).toBe(1);

    // 第 3 次语义写入前评估轮换理由：旧块封口 + 实体复制，随后本次实体写进新块。
    await harness.writeSemantic("tool", { entityId: "tool-b", toolCallId: "call-b" });

    const rows = harness.docsOfKind("runtime");
    expect(rows.map((row) => row.state)).toEqual(["sealed", "active"]);
    const predecessor = required(rows[0], "sealed runtime block");
    const successor = required(rows[1], "active runtime block");
    expect(
      (await harness.canonicalEntities(successor.docId)).map((entity) => `${entity.entityId}/${entity.state}`),
    ).toEqual(["perm-a/open", "tool-a/open", "tool-b/open"]);
    // 旧块已封口：后续运行态写入只落新块，旧块摘要保持不变（同一 docId 只有一个已发布谱系）。
    const sealedDigest = await harness.canonicalDigest(predecessor.docId);
    await harness.writeSemantic("error", { entityId: "turn-1:error" });
    expect(await harness.canonicalDigest(predecessor.docId)).toBe(sealedDigest);
    expect(harness.docsOfKind("runtime").length).toBe(2);
  });
});

// ------------------------------------------------------------------ T06

describe("T06 旧轮尾部与新输入交错", () => {
  // 合并缓冲只按「相同键」合并：旧轮尾部还在缓冲里时，新轮输入到达必须先冲刷旧轮，不得把两轮写进同一记录。
  test("旧轮尾部排队时新轮输入不串轮", async () => {
    const harness = await open({ merge: { maxBytes: 4096, maxDelayMs: 3_600_000 } });
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId]);

    await harness.writeText("turn-1 第一段", { turnId: "turn-1" });
    await harness.writeText("turn-2 用户输入", { turnId: "turn-2" });
    await harness.writeText("turn-1 尾部", { turnId: "turn-1" });
    // 语义屏障（轮次结束）触发最后一次冲刷：缓冲里剩下的那一轮必须落定。
    await harness.writeSemantic("cancel", { entityId: "turn-1:cancel", metadata: { status: "cancelled" } });

    // oracle：我记录的输入序列按接收顺序拼接，就是每个 entry/slot 的唯一期望。
    await expectLiveTextMatchesLog(harness, [harness.seedContentDocId]);
    expect(harness.log.textKeys().map((key) => key.entryId)).toEqual(["turn-1:assistant", "turn-2:assistant"]);
    const records = await harness.canonicalRecords(harness.seedContentDocId);
    expect(liveText(records, "turn-1:assistant", TEXT_SLOT)).toBe("turn-1 第一段turn-1 尾部");
    expect(liveText(records, "turn-2:assistant", TEXT_SLOT)).toBe("turn-2 用户输入");
    // 两个轮次各占独立记录：没有任何一条记录横跨两轮。
    expect(records.filter((record) => record.kind === "text").map((record) => record.entryId)).toEqual([
      "turn-1:assistant",
      "turn-2:assistant",
      "turn-1:assistant",
    ]);
  });

  // 同一轮内超过合并阈值就立刻落库：阈值只影响记录条数，不影响每个 entry/slot 的拼接结果。
  test("同一轮内跨阈值落库后文本仍逐字相等", async () => {
    const harness = await open({ merge: { maxBytes: 8, maxDelayMs: 3_600_000 } });
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId]);

    await harness.writeText("abcd", { turnId: "turn-1" });
    await harness.writeText("efgh", { turnId: "turn-1" });
    await harness.writeText("ij", { turnId: "turn-1" });
    await harness.writeSemantic("error", { entityId: "turn-1:error", metadata: { status: "failed" } });

    await expectLiveTextMatchesLog(harness, [harness.seedContentDocId]);
    expect(await textOfBothSides(harness, harness.seedContentDocId, "turn-1:assistant", TEXT_SLOT)).toBe("abcdefghij");
  });

  // 推理槽位与正文槽位是两个 key：同一轮的两条流不得互相合并或覆盖。
  test("同一轮的正文与推理槽位互不覆盖", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId]);

    const events: SyncIngressEvent[] = [
      ...normalizeAcpSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        turnId: "turn-1",
        content: { type: "text", text: "正文" },
      }),
      ...normalizeAcpSessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        turnId: "turn-1",
        content: { type: "text", text: "思考" },
      }),
    ];
    for (const event of events) await harness.write(event);

    await expectLiveTextMatchesLog(harness, [harness.seedContentDocId]);
    const records = await harness.canonicalRecords(harness.seedContentDocId);
    expect(liveText(records, "turn-1:assistant", TEXT_SLOT)).toBe("正文");
    expect(liveText(records, "turn-1:assistant", "reasoning")).toBe("思考");
  });
});

// ------------------------------------------------------------------ T07

describe("T07 封口提交点与断线恢复", () => {
  // 单条增量超过分片上限时写入层先封口当前块再拆小重写：旧块摘要此后不变，正文跨块仍可完整重建。
  test("封口后摘要不变且正文跨块完整重建", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId]);
    await harness.writeText("第一块正文");

    const tail = "尾".repeat(40 * 1024);
    await harness.writeText(tail);

    const rows = harness.docsOfKind("content");
    expect(rows.length).toBe(2);
    const sealed = required(rows[0], "sealed content block");
    const successor = required(rows[1], "successor content block");
    expect([sealed.state, successor.state]).toEqual(["sealed", "active"]);
    const sealedDigest = await harness.canonicalDigest(sealed.docId);

    await harness.writeText("第二块继续");

    expect(await harness.canonicalDigest(sealed.docId)).toBe(sealedDigest);
    const sealedRecords = await harness.canonicalRecords(sealed.docId);
    const successorRecords = await harness.canonicalRecords(successor.docId);
    expect(liveText(sealedRecords, "turn-1:assistant", TEXT_SLOT)).toBe("第一块正文");
    expect(liveText(successorRecords, "turn-1:assistant", TEXT_SLOT)).toBe(`${tail}第二块继续`);
    // 两个块合起来仍是完整正文，且与 oracle 逐字相等。
    await expectLiveTextMatchesLog(harness, [sealed.docId, successor.docId]);
  });

  // 断线只丢在途帧，不丢已提交内容：新连接重新握手订阅后拿到的字节与 store 的已提交边界逐字节相同。
  test("丢帧断线后新连接可从已提交边界完整恢复", async () => {
    const first = await open();
    await first.handshake();
    await first.subscribe([first.seedContentDocId]);
    await first.writeText("断线前正文");

    // 断线：socket 已经掉了（服务端出帧全部丢弃，客户端永远收不到这段增量），服务端继续提交已接收的字节。
    first.link.dropServerFrame = () => true;
    await first.writeText("断线期间正文");
    // 客户端只到断线前的边界：丢掉的增量没进镜像，而服务端已提交边界已经包含它——缺口真实存在。
    expect(liveText(first.mirror.readRecords(first.seedContentDocId), "turn-1:assistant", TEXT_SLOT)).toBe(
      "断线前正文",
    );
    expect(liveText(await first.canonicalRecords(first.seedContentDocId), "turn-1:assistant", TEXT_SLOT)).toBe(
      "断线前正文断线期间正文",
    );
    // 宿主终止这条连接：真正断连（而不是把帧丢掉却让旧连接继续持着写者租约）。
    await first.dispose();

    const second = await open({ reuse: first, seed: "reconnect" });
    await second.handshake();
    await second.subscribe([second.seedContentDocId]);

    const storeBytes = await first.canonicalBytes(first.seedContentDocId);
    const mirrorBytes = second.mirror.canonicalBytes(second.seedContentDocId);
    expect(mirrorBytes).not.toBeNull();
    expect(byteDifference(required(mirrorBytes, "reconnected mirror bytes"), storeBytes)).toBeNull();
    expect(liveText(second.mirror.readRecords(second.seedContentDocId), "turn-1:assistant", TEXT_SLOT)).toBe(
      "断线前正文断线期间正文",
    );
  });

  // 换代只切换指针，不重写已封口的实时块：旧块的 canonical 摘要与字节在导入前后必须完全一致。
  test("换代不重写已封口的实时块", async () => {
    const harness = await open();
    await harness.handshake();
    await harness.subscribe([harness.seedContentDocId]);
    await harness.writeText("换代前的实时正文");

    const before = harness.docsOfKind("content").map((row) => `${row.docId}:${row.hash}`);
    const beforeBytes = await harness.canonicalBytes(harness.seedContentDocId);

    // 换代要求导入方持写权，而写权是 TTL 租约：先真正终止实时连接（宿主关闭 socket），再让租约到期让位。
    await harness.dispose();
    harness.time.advance(LIVE_WRITER_LEASE_TTL_MS + 1);

    await harness.beginImport();
    await harness.acceptHistoryText("换代后的历史正文", { entryId: "legacy-1" });
    const result = await harness.finishImport();

    expect(result.generation).not.toBe(harness.seedGeneration);
    expect(await harness.currentGeneration()).toBe(result.generation);
    const after = harness.docsOfKind("content").map((row) => `${row.docId}:${row.hash}`);
    for (const entry of before) expect(after).toContain(entry);
    expect(byteDifference(await harness.canonicalBytes(harness.seedContentDocId), beforeBytes)).toBeNull();
    // 新代次的入口闭包指向导入提交的块，历史内容经它可读回。
    const closure = await harness.currentEntryRefs();
    expect(closure.contentDocIds.length).toBeGreaterThan(0);
    expect(joinPayloadText(await harness.flatRecords(), "legacy-1", 0)).toBe("换代后的历史正文");
  });
});
