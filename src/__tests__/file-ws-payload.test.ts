import { describe, expect, test } from "bun:test";
import {
  checkParsedObjectSize,
  checkWsMessageSize,
  DEFAULT_FILE_WS_MAX_PAYLOAD_MB,
  estimateWsMessageBytes,
  parseFileWsMessage,
} from "../transport/file-ws-payload";

// file-ws 载荷治理（P1-11a，D12）纯函数单测：file-ws-payload 为无副作用模块，
// 不依赖 env / handler 状态，直接静态 import（与 setup-mocks preload 无冲突）。

describe("checkWsMessageSize 解析前载荷检查", () => {
  test("超过 32MB 默认上限的原始字符串被拒绝（D12 解析前检查）", () => {
    // 20MB upload 的 base64 帧 ~27MB < 32MB 应放行，超过 32MB 的帧必须在解析前拒绝
    const maxPayloadBytes = DEFAULT_FILE_WS_MAX_PAYLOAD_MB * 1024 * 1024;
    expect(checkWsMessageSize("x".repeat(maxPayloadBytes + 1), maxPayloadBytes)).toBe(true);
  });

  test("字节数恰好等于上限时不拒绝，超过 1 字节才拒绝", () => {
    // 上限是开区间（>max 拒绝），边界帧不应误杀（20MB upload base64 帧接近 27MB，离 32MB 有裕量）
    expect(checkWsMessageSize("x".repeat(1024), 1024)).toBe(false);
    expect(checkWsMessageSize("x".repeat(1025), 1024)).toBe(true);
  });

  test("多字节 UTF-8 字符按真实字节数计算，而非字符数", () => {
    // file-ws 帧含中文路径等非 ASCII 内容，data.length（UTF-16 码元）会低估真实大小；
    // 必须按 Buffer.byteLength 计字节，否则多字节载荷可绕过上限
    expect(Buffer.byteLength("你")).toBe(3);
    expect(checkWsMessageSize("你".repeat(1024), 3 * 1024)).toBe(false);
    expect(checkWsMessageSize("你".repeat(1024), 3 * 1024 - 1)).toBe(true);
  });

  test("二进制帧按 byteLength 检查", () => {
    // 防御性覆盖二进制分支（协议为 NDJSON 文本，但 checkWsMessageSize 对 Uint8Array 同样生效）
    expect(checkWsMessageSize(new Uint8Array(1025), 1024)).toBe(true);
    expect(checkWsMessageSize(new Uint8Array(1024), 1024)).toBe(false);
  });
});

describe("checkParsedObjectSize object 帧补充检查", () => {
  test("Elysia 默认 parse 后的 object 帧按重序列化字节数拒绝（修复单行 JSON 帧绕过）", () => {
    // 单行 JSON 帧被 createWSMessageParser 提前 parse 成 object 后，typeof string 检查
    // 会被绕过；object 帧必须重序列化后按字节比较（acp-ws/yjs/relay 10MB 上限的防线）
    const big = { payload: "x".repeat(1024 * 1024) };
    expect(checkParsedObjectSize(big, 1024)).toBe(true);
    expect(checkParsedObjectSize(big, 2 * 1024 * 1024)).toBe(false);
  });

  test("小 object 帧放行，Uint8Array / 原始值不误伤", () => {
    // 正常 JSON-RPC 帧体量小，检查零开销放行；二进制帧与原始值不属于 object 分支
    expect(checkParsedObjectSize({ jsonrpc: "2.0", method: "ping" }, 1024)).toBe(false);
    expect(checkParsedObjectSize(new Uint8Array(1025), 1024)).toBe(false);
    expect(checkParsedObjectSize("x".repeat(2048), 1024)).toBe(false);
    expect(checkParsedObjectSize(null, 1024)).toBe(false);
  });

  test("不可序列化载荷（循环引用）视为超限，保守拒绝", () => {
    // JSON.parse 不可能产生循环引用，只可能来自异常路径；保守拒绝而非崩溃或放行
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(checkParsedObjectSize(circular, 1024 * 1024)).toBe(true);
  });

  test("estimateWsMessageBytes 与日志口径一致：字符串按 UTF-8 字节", () => {
    // 日志打印的字节数与检查口径必须一致（同源函数），非 ASCII 内容不低估
    expect(estimateWsMessageBytes("你".repeat(3))).toBe(9);
    expect(estimateWsMessageBytes({ a: "你" })).toBe(Buffer.byteLength(JSON.stringify({ a: "你" })));
    expect(estimateWsMessageBytes(new Uint8Array(7))).toBe(7);
    expect(estimateWsMessageBytes(42)).toBe(0);
  });
});

describe("parseFileWsMessage NDJSON 解析", () => {
  test("NDJSON 多行消息逐行解析为独立消息，顺序保持", () => {
    // 机器端批量上报（如 keep_alive + file_op_result）在同一帧内以 \n 分隔，
    // 逐行解析必须保留行序，保证 register/file_op_result 按发送顺序处理
    const messages = parseFileWsMessage(
      '{"type":"register","machine_id":"mach_1"}\n{"type":"file_op_result","request_id":"r1","status":"ok"}\n{"type":"keep_alive"}\n',
    );
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ type: "register", machine_id: "mach_1" });
    expect(messages[1]).toEqual({ type: "file_op_result", request_id: "r1", status: "ok" });
    expect(messages[2]).toEqual({ type: "keep_alive" });
  });

  test("解析失败的行被跳过并记日志，不中断其余行", () => {
    // 单条坏帧（如半截 JSON）不应丢弃整批消息：坏行跳过，后续好行继续解析
    const messages = parseFileWsMessage(
      '{"type":"file_op_result","request_id":"r1"}\n{broken json}\n{"type":"keep_alive"}',
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ type: "file_op_result", request_id: "r1" });
    expect(messages[1]).toEqual({ type: "keep_alive" });
  });

  test("空行与纯空白行被忽略", () => {
    // 机器端帧尾可能带多余换行/空白，不应解析出空消息或报错
    expect(parseFileWsMessage("")).toEqual([]);
    expect(parseFileWsMessage("\n  \n\t\n")).toEqual([]);
    expect(parseFileWsMessage('{"type":"keep_alive"}\n\n{"type":"keep_alive"}\n')).toHaveLength(2);
  });

  test("单行 JSON 对象帧解析为单条消息", () => {
    // 单条消息帧（最常见形态）与多行帧共用同一解析路径
    expect(parseFileWsMessage('{"type":"register","machine_id":"mach_1"}')).toEqual([
      { type: "register", machine_id: "mach_1" },
    ]);
  });

  test("解析成功但非对象（null / 数组 / 原始值）的行跳过，不进入 handler 崩溃路径", () => {
    // null 进入 handler 会在 msg.type 访问时抛 TypeError；数组/原始值无 type 语义，
    // 协议只接受 { type, ... } 对象帧——全部跳过并记日志，不中断其余行
    expect(parseFileWsMessage('null\n[1,2]\n"str"\n42\n{"type":"keep_alive"}')).toEqual([{ type: "keep_alive" }]);
  });
});
