import { describe, expect, test } from "bun:test";
import { INPUT_LIMITS } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import {
  fidelityDeserialize,
  fidelitySerialize,
  type JsonPart,
  type JsonScanLimits,
  joinJsonParts,
  joinStringParts,
  scanJsonText,
  splitJsonParts,
  splitStringParts,
  summarizePayload,
} from "../sync/history/fidelity-json";
import { SyncProtocolError } from "../sync/protocol/errors";

/** 宽松上限：只用来验证「正常载荷不被容量拦下」，容量用例各自收窄单一维度。 */
const BASE_LIMITS: JsonScanLimits = { maxBytes: 1 << 20, maxDepth: 64, maxNodes: 65536 };
const UTF8 = new TextEncoder();
/** 严格解码器：用于证明某个分片单独拿出来不是合法 UTF-8（即确实切在多字节字符中间）。 */
const STRICT_DECODER = new TextDecoder("utf-8", { fatal: true });

/** 捕获本层协议错误；非本层异常原样抛出以免掩盖真实缺陷。 */
function captureSyncError(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected SyncProtocolError to be thrown");
}

/** 逐代码单元比对：`toBe` 相等已经足够，但代码单元级断言能明确排除「被替换成 U+FFFD 后仍“看起来相等”」。 */
function expectSameCodeUnits(actual: string, expected: string): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(actual.charCodeAt(index)).toBe(expected.charCodeAt(index));
  }
}

/**
 * 是否含 U+FFFD 替换字符。
 *
 * 不能用 `toContain("\ufffd")`：Bun 的字符串匹配会把孤立代理项视同 U+FFFD，导致「按代码单元原样保留」
 * 的分片被误判成已替换；逐代码单元比对才是这里要断言的事实。
 */
function hasReplacementCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0xfffd) return true;
  }
  return false;
}

describe("保真序列化与反序列化", () => {
  // 孤立代理项是最容易被静默修正的输入：往返后必须仍是同一代码单元，不得变成 U+FFFD。
  test("孤立代理项往返保持同一代码单元", () => {
    const loneSurrogate = "\ud800";
    const bytes = fidelitySerialize(loneSurrogate);
    // 字节层必须是转义序列而非原始孤立代理项，否则编码器会把 U+FFFD 写进载荷。
    expect(new TextDecoder().decode(bytes)).toBe('"\\ud800"');
    const restored = fidelityDeserialize(bytes);
    expect(restored).toBe(loneSurrogate);
    expect((restored as string).charCodeAt(0)).toBe(0xd800);
  });

  // 合法代理对与孤立代理项混排时，两类代码单元都不能被替换或补齐。
  test("合法代理对与孤立代理项混排往返逐代码单元相等", () => {
    const text = "a\ud83d\ude00b\udc00c\ud800";
    const bytes = fidelitySerialize({ text });
    const restored = fidelityDeserialize(bytes);
    expect(restored).toEqual({ text });
    expectSameCodeUnits((restored as { text: string }).text, text);
  });

  // 空白串必须原样保留：trim 一次就会让「内容 = 空白」的消息永久丢失。
  test("空白串往返不做 trim", () => {
    for (const text of ["   ", "\n\t\r", " a ", "\u00a0 a \u00a0"]) {
      const bytes = fidelitySerialize({ text });
      const restored = fidelityDeserialize(bytes) as { text: string };
      expectSameCodeUnits(restored.text, text);
    }
  });

  // 不做 Unicode 规范化：NFC 与 NFD 是两个不同的字节序列，规范化会篡改用户的原始输入。
  test("NFC 与 NFD 串各自往返且互不合并", () => {
    const nfc = "é"; // U+00E9
    const nfd = "e\u0301"; // e + U+0301
    expect(nfc).not.toBe(nfd);
    expectSameCodeUnits(fidelityDeserialize(fidelitySerialize(nfc)) as string, nfc);
    expectSameCodeUnits(fidelityDeserialize(fidelitySerialize(nfd)) as string, nfd);
    expect(fidelitySerialize(nfc)).not.toEqual(fidelitySerialize(nfd));
  });

  // CRLF 是正文语义的一部分：JSON 转义后往返必须还是 CRLF，不能被规范成 LF。
  test("CRLF 与行尾不变形", () => {
    const value = { text: "line1\r\nline2\r\n", tail: "\n" };
    const bytes = fidelitySerialize(value);
    const encoded = new TextDecoder().decode(bytes);
    expect(encoded).toContain("\\r\\n");
    expect(encoded).not.toContain("\r");
    expect(fidelityDeserialize(bytes)).toEqual(value);
  });

  // 空载荷不能被当成「没有内容」吞掉：它要能独立成条；相同内容两次编码必须得到同一摘要。
  test("空字符串与重复内容互不干扰", () => {
    const empty = fidelitySerialize("");
    const first = fidelitySerialize("同一条内容");
    const second = fidelitySerialize("同一条内容");
    expect(empty.byteLength).toBe(2); // `""`
    expect(fidelityDeserialize(empty)).toBe("");
    expect(first).toEqual(second);
    expect(summarizePayload(empty).digest).not.toBe(summarizePayload(first).digest);
    expect(joinJsonParts(splitJsonParts(empty, 4))).toEqual(empty);
    expect(joinJsonParts(splitJsonParts(first, 4))).toEqual(first);
  });

  // 无 JSON 表示的值与坏字节必须显式失败：静默产出空字节或替换字符都会伪装成「内容为空/内容完整」。
  test("不可序列化的值与坏载荷显式失败", () => {
    expect(captureSyncError(() => fidelitySerialize(undefined)).code).toBe("MALFORMED_FRAME");
    expect(captureSyncError(() => fidelitySerialize(() => 1)).code).toBe("MALFORMED_FRAME");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(captureSyncError(() => fidelitySerialize(circular)).code).toBe("MALFORMED_FRAME");
    expect(captureSyncError(() => fidelityDeserialize(new Uint8Array([0xff, 0xfe]))).code).toBe("MALFORMED_FRAME");
    expect(captureSyncError(() => fidelityDeserialize(UTF8.encode("{ not json }"))).code).toBe("MALFORMED_FRAME");
  });
});

describe("解析前的有界扫描", () => {
  // 扫描统计要与编码字节数严格一致（多字节字符、代理对都不能算错），深度与节点数按同一口径计数。
  test("字节数、深度与节点数统计正确", () => {
    const text = '{"a":[1,{"b":"中文😀"}],"c":true}';
    const stats = scanJsonText(text, BASE_LIMITS);
    expect(stats.bytes).toBe(UTF8.encode(text).byteLength);
    expect(stats.depth).toBe(3);
    expect(stats.nodes).toBe(6); // 根对象 + 数组 + 1 + 内层对象 + 字符串 + true，对象键不单独计
    expect(scanJsonText(" 42 ", BASE_LIMITS)).toEqual({ bytes: 4, depth: 0, nodes: 1 });
  });

  // 原始孤立代理项的计数必须与 TextEncoder 的替换结果对齐，否则「扫描字节数 == 编码字节数」不成立。
  test("孤立代理项的字节计数与 TextEncoder 一致", () => {
    const text = '["\ud800","😀"]';
    expect(scanJsonText(text, BASE_LIMITS).bytes).toBe(UTF8.encode(text).byteLength);
  });

  // 结构炸弹的字节数很小，深度上限必须在解析之前独立生效。
  test("超深度抛 CAPACITY_EXCEEDED 并指明 maxDepth", () => {
    const nested = `${"[".repeat(10)}1${"]".repeat(10)}`;
    expect(scanJsonText(nested, { ...BASE_LIMITS, maxDepth: 10 }).depth).toBe(10);
    const error = captureSyncError(() => scanJsonText(nested, { ...BASE_LIMITS, maxDepth: 9 }));
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(error.message).toContain("maxDepth");
  });

  // 节点上限挡住「宽而浅」的放大载荷：数组本身只算 1 个节点，元素逐个计数。
  test("超节点数抛 CAPACITY_EXCEEDED 并指明 maxNodes", () => {
    const flat = "[1,1,1,1,1,1]";
    expect(scanJsonText(flat, { ...BASE_LIMITS, maxNodes: 7 }).nodes).toBe(7);
    const error = captureSyncError(() => scanJsonText(flat, { ...BASE_LIMITS, maxNodes: 6 }));
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(error.message).toContain("maxNodes");
  });

  // 字节上限按 UTF-8 计：同一个字符串用中文字符时占用 3 倍字节，不能按代码单元数判断。
  test("超字节数抛 CAPACITY_EXCEEDED 并指明 maxBytes", () => {
    const text = '"中中文😀"';
    expect(scanJsonText(text, { ...BASE_LIMITS, maxBytes: UTF8.encode(text).byteLength }).bytes).toBe(15);
    const error = captureSyncError(() => scanJsonText(text, { ...BASE_LIMITS, maxBytes: 14 }));
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(error.message).toContain("maxBytes");
  });

  // 非有限数字字面量会静默变成 null、非法转义会变成未定义字符：都必须在进入解析前失败。
  test("非有限数字字面量与非法转义抛 MALFORMED_FRAME", () => {
    for (const text of ["[NaN]", "[Infinity]", "[-Infinity]", "[1e999]", '["\\q"]', '["\\u12"]', '["a\u0001b"]']) {
      expect(captureSyncError(() => scanJsonText(text, BASE_LIMITS)).code).toBe("MALFORMED_FRAME");
    }
  });

  // 扫描的接受域必须与 JSON.parse 对齐：放行解析器不接受的输入等于把失败推迟到更晚、更贵的地方。
  test("接受域与 JSON.parse 一致", () => {
    const accepted = ['{"a":1}', "[1,2,3]", '"x"', "true", "null", "-0.5e+3", '"\\u0041"', "[]", '{"a":{}}'];
    const rejected = ["{a:1}", "{'a':1}", "[01]", "[.5]", "[1.]", "[+1]", "{} {}", "", "   ", "[1,]", "[,1]", "[1 2]"];
    for (const text of accepted) {
      expect(() => scanJsonText(text, BASE_LIMITS)).not.toThrow();
      expect(() => JSON.parse(text)).not.toThrow();
    }
    for (const text of rejected) {
      expect(captureSyncError(() => scanJsonText(text, BASE_LIMITS)).code).toBe("MALFORMED_FRAME");
      expect(() => JSON.parse(text)).toThrow();
    }
  });
});

describe("按字节分片与重组", () => {
  // 分片按字节切：多字节字符可以被切断，但重组后必须还原成同一个 JSON 值（数组顺序也不得改变）。
  test("切断多字节字符的分片重组后语义相等", () => {
    const value = { title: "中文标题 😀", items: ["重复", "重复"], num: 1.5 };
    const bytes = fidelitySerialize(value);
    const parts = splitJsonParts(bytes, 5);
    expect(parts.length).toBeGreaterThan(1);
    let straddles = false;
    for (const part of parts) {
      try {
        STRICT_DECODER.decode(part.payload);
      } catch {
        straddles = true;
      }
    }
    expect(straddles).toBe(true);
    expect(fidelityDeserialize(joinJsonParts(parts))).toEqual(value);
  });

  // 分片不得与调用方缓冲共享内存，否则一次外部改写就能篡改已计入摘要的载荷。
  test("分片复制载荷且区间自洽", () => {
    const bytes = fidelitySerialize({ a: "中文" }); // 14 字节，按 3 字节切片得到 5 片
    const parts = splitJsonParts(bytes, 3);
    expect(parts.length).toBe(5);
    for (const part of parts) {
      expect(part.partCount).toBe(parts.length);
      expect(part.byteEnd - part.byteStart).toBe(part.payload.byteLength);
      expect(part.digest).toBe(sha256Digest(bytes));
    }
    bytes[0] = 0;
    expect(joinJsonParts(parts)).not.toEqual(bytes);
  });

  // 缺片与区间不连续都必须报「未同步」，绝不能退化成「内容为空」。
  test("缺片、索引重复与区间不连续抛 IMPORT_INCOMPLETE", () => {
    const parts = splitJsonParts(fidelitySerialize({ a: "中文" }), 3);
    expect(captureSyncError(() => joinJsonParts([])).code).toBe("IMPORT_INCOMPLETE");
    expect(captureSyncError(() => joinJsonParts(parts.slice(0, parts.length - 1))).code).toBe("IMPORT_INCOMPLETE");
    const duplicated = [...parts.slice(0, 2), parts[1], ...parts.slice(2)];
    expect(duplicated.length).toBe(parts.length + 1);
    expect(captureSyncError(() => joinJsonParts(duplicated)).code).toBe("IMPORT_INCOMPLETE");
    const gapped = parts.map((part) => {
      if (part.partIndex !== 1) return part;
      return { ...part, byteStart: part.byteStart + 1, byteEnd: part.byteEnd + 1 };
    });
    expect(captureSyncError(() => joinJsonParts(gapped)).code).toBe("IMPORT_INCOMPLETE");
  });

  // 篡改一个字节必须被摘要发现：这是「不能靠分片元数据自证完整」的回归防线。
  test("篡改一个字节抛 DIGEST_CONFLICT", () => {
    const bytes = fidelitySerialize({ a: [1, 2, 3], b: "中文" });
    const parts = splitJsonParts(bytes, 4);
    const target = parts[1];
    const tampered = Uint8Array.from(target.payload);
    tampered[0] = (tampered[0] + 1) % 256;
    const mixed: JsonPart[] = parts.map((part) => (part.partIndex === 1 ? { ...part, payload: tampered } : part));
    expect(captureSyncError(() => joinJsonParts(mixed)).code).toBe("DIGEST_CONFLICT");
    expect(fidelityDeserialize(joinJsonParts(parts))).toEqual({ a: [1, 2, 3], b: "中文" });
  });

  // 混入其它载荷的分片同样按摘要冲突处理：分片可按索引拼齐，但内容来源不同。
  test("混入其它载荷的分片抛 DIGEST_CONFLICT", () => {
    const left = splitJsonParts(fidelitySerialize("aaa"), 2);
    const right = splitJsonParts(fidelitySerialize("bbb"), 2);
    expect(left.length).toBe(right.length);
    const error = captureSyncError(() => joinJsonParts([left[0], right[1], left[2]]));
    expect(error.code).toBe("DIGEST_CONFLICT");
  });

  // 空载荷也必须有分片：分片是摘要的唯一载体，0 片会让「空数组」冒充完整性证明。
  test("空载荷产出一个零长度分片", () => {
    const parts = splitJsonParts(new Uint8Array(0), 4);
    expect(parts).toEqual([
      {
        partIndex: 0,
        partCount: 1,
        byteStart: 0,
        byteEnd: 0,
        digest: sha256Digest(new Uint8Array(0)),
        payload: new Uint8Array(0),
      },
    ]);
    expect(joinJsonParts(parts)).toEqual(new Uint8Array(0));
  });
});

describe("实时字符串按代码单元分片", () => {
  // 上限小于代理对宽度时允许切在代理对中间：两侧各是孤立代理项，拼接后必须逐代码单元还原。
  test("允许在代理对中间切分且不做字符替换", () => {
    const text = "a😀b"; // a + \ud83d\ude00 + b
    const parts = splitStringParts(text, 3);
    expect(parts).toEqual(["a", "\ud83d", "\ude00", "b"]);
    for (const part of parts) {
      expect(hasReplacementCharacter(part)).toBe(false);
      expect(UTF8.encode(part).byteLength).toBeLessThanOrEqual(3);
    }
    expectSameCodeUnits(joinStringParts(parts), text);
  });

  // 预算够宽时代理对整体保留：少一次切分就少一次下游处理孤立代理项的机会。
  test("预算足够时代理对整体保留", () => {
    expect(splitStringParts("ab😀", 6)).toEqual(["ab😀"]);
    expect(splitStringParts("ab😀", 5)).toEqual(["ab", "😀"]);
  });

  // 空串没有分片且拼接回空串；非法上限属于配置错误，必须显式拒绝而不是死循环或产出空分片。
  test("空串与非法上限的边界行为", () => {
    expect(splitStringParts("", 4)).toEqual([]);
    expect(joinStringParts([])).toBe("");
    expect(captureSyncError(() => splitStringParts("x", 0)).code).toBe("ADMISSION_REJECTED");
    expect(captureSyncError(() => splitJsonParts(UTF8.encode("[]"), 0)).code).toBe("ADMISSION_REJECTED");
    expect(captureSyncError(() => summarizePayload(UTF8.encode("[]"), -1)).code).toBe("ADMISSION_REJECTED");
  });

  // 代码围栏、链接这类长文本按同一预算切片时，逐片拼接必须还原原文（不得补字符或改顺序）。
  test("长文本分片往返逐代码单元相等", () => {
    const text = '```ts\nconst a = "中文"; // 😀\n```\n- [链接](https://example.com)\r\n';
    const parts = splitStringParts(text, 8);
    expect(parts.length).toBeGreaterThan(5);
    for (const part of parts) expect(hasReplacementCharacter(part)).toBe(false);
    expectSameCodeUnits(joinStringParts(parts), text);
  });
});

describe("逻辑对象摘要", () => {
  // 内容类型决定下游按结构化值还是按文本处理：只有对象/数组算 JSON，裸标量与坏字节都按文本。
  test("contentType 判定按结构而非「能否解析」", () => {
    expect(summarizePayload(UTF8.encode('{"a":1}')).contentType).toBe("json");
    expect(summarizePayload(UTF8.encode("  [1, 2]  ")).contentType).toBe("json");
    expect(summarizePayload(UTF8.encode("## 标题\n正文 😀")).contentType).toBe("text");
    expect(summarizePayload(UTF8.encode("123")).contentType).toBe("text");
    expect(summarizePayload(UTF8.encode("true")).contentType).toBe("text");
    expect(summarizePayload(UTF8.encode("{ not json }")).contentType).toBe("text");
    expect(summarizePayload(new Uint8Array([0xff, 0xfe, 0x00])).contentType).toBe("text");
  });

  // partCount 必须与 splitJsonParts 的同一算式对齐，否则摘要与实际分片数不一致会让目录校验失真。
  test("partCount 与实际分片数一致且默认粒度来自 profile", () => {
    const small = UTF8.encode('{"a":"中文"}');
    expect(summarizePayload(small, 4).partCount).toBe(splitJsonParts(small, 4).length);
    expect(summarizePayload(small).partCount).toBe(1);
    const big = new Uint8Array(20000);
    expect(summarizePayload(big).partCount).toBe(Math.ceil(20000 / INPUT_LIMITS.payloadChunkMaxBytes));
    expect(summarizePayload(big).partCount).toBe(splitJsonParts(big, INPUT_LIMITS.payloadChunkMaxBytes).length);
    expect(summarizePayload(new Uint8Array(0)).partCount).toBe(1);
  });

  // 摘要三个字段要能独立核对：总字节数、SHA-256 摘要（64 位小写十六进制）与内容类型。
  test("总字节数与摘要字段正确", () => {
    const bytes = UTF8.encode('{"a":1}');
    const summary = summarizePayload(bytes);
    expect(summary.totalBytes).toBe(bytes.byteLength);
    expect(summary.digest).toBe(sha256Digest(bytes));
    expect(summary.digest).toMatch(/^[0-9a-f]{64}$/);
    const altered = Uint8Array.from(bytes);
    altered[1] = 0x62; // "a" -> "b"
    expect(summarizePayload(altered).digest).not.toBe(summary.digest);
  });
});
