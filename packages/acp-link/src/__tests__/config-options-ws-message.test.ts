import { describe, expect, test } from "bun:test";
import { extractModelState, extractModeState } from "../config-options-utils.js";
import { decodeJsonWsMessage, MAX_CLIENT_WS_PAYLOAD_BYTES, WsPayloadTooLargeError } from "../ws-message.js";

describe("configOptions 状态转换", () => {
  // 缺失配置时不应虚构模型状态。
  test("模型配置为空时返回 null", () => {
    expect(extractModelState(undefined)).toBeNull();
    expect(extractModelState(null)).toBeNull();
  });

  // 非 select 配置不是可选模型，必须被忽略。
  test("模型配置不是 select 时返回 null", () => {
    expect(extractModelState([{ id: "model", type: "text", options: [] }])).toBeNull();
  });

  // 通过 id 识别模型配置，并保留当前选中的合法模型。
  test("按 id 解析合法模型选择", () => {
    expect(
      extractModelState([
        {
          id: "model",
          type: "select",
          currentValue: "sonnet",
          options: [{ value: "sonnet", name: "Sonnet", description: "快速" }],
        },
      ]),
    ).toEqual({
      currentModelId: "sonnet",
      availableModels: [{ modelId: "sonnet", name: "Sonnet", description: "快速", modalities: null }],
    });
  });

  // 仅提供 category 的 Agent 仍应识别模型选择。
  test("按 category 解析模型选择", () => {
    expect(
      extractModelState([
        { category: "model", type: "select", value: "gpt", options: [{ value: "gpt", name: "GPT" }] },
      ]),
    ).toMatchObject({ currentModelId: "gpt", availableModels: [{ modelId: "gpt", name: "GPT" }] });
  });

  // 分组 options 必须拍平，避免前端丢失分组内模型。
  test("拍平分组模型选项", () => {
    expect(
      extractModelState([
        {
          id: "model",
          type: "select",
          currentValue: "large",
          options: [
            {
              group: "推荐",
              options: [
                { value: "small", name: "Small" },
                { value: "large", name: "Large" },
              ],
            },
          ],
        },
      ]),
    ).toMatchObject({ currentModelId: "large", availableModels: [{ modelId: "small" }, { modelId: "large" }] });
  });

  // Agent 返回未公布的当前模型时应安全回退到首个可用项。
  test("非法当前模型回退到首个可用项", () => {
    expect(
      extractModelState([
        { id: "model", type: "select", currentValue: "hidden", options: [{ value: "public", name: "Public" }] },
      ]),
    ).toMatchObject({ currentModelId: "public" });
  });

  // 没有可选项时不能擅自覆盖 Agent 返回的当前模型。
  test("空模型列表保留当前模型", () => {
    expect(extractModelState([{ id: "model", type: "select", currentValue: "internal", options: [] }])).toMatchObject({
      currentModelId: "internal",
      availableModels: [],
    });
  });

  // currentValue 应优先于旧版 value 字段。
  test("模型 currentValue 优先于 value", () => {
    expect(
      extractModelState([
        { id: "model", type: "select", currentValue: "new", value: "old", options: [{ value: "new", name: "New" }] },
      ]),
    ).toMatchObject({ currentModelId: "new" });
  });

  // 缺失 option 字段应转换为稳定的空字符串与 null。
  test("缺失模型字段时提供稳定默认值", () => {
    expect(extractModelState([{ id: "model", type: "select", options: [{}] }])).toEqual({
      currentModelId: "",
      availableModels: [{ modelId: "", name: "", description: null, modalities: null }],
    });
  });

  // 缺失模式配置时不应产生空模式状态。
  test("模式配置不存在时返回 null", () => {
    expect(extractModeState([{ id: "model", type: "select", options: [] }])).toBeNull();
  });

  // category 模式配置及分组选项应完整转换。
  test("按 category 解析分组模式选项", () => {
    expect(
      extractModeState([
        {
          category: "mode",
          type: "select",
          value: "plan",
          options: [{ group: "工作流", options: [{ value: "plan", name: "Plan", description: "先规划" }] }],
        },
      ]),
    ).toEqual({ currentModeId: "plan", availableModes: [{ id: "plan", name: "Plan", description: "先规划" }] });
  });

  // 非法模式必须回退，避免 UI 保存不可用的选择值。
  test("非法当前模式回退到首个可用项", () => {
    expect(
      extractModeState([
        { id: "mode", type: "select", currentValue: "removed", options: [{ value: "ask", name: "Ask" }] },
      ]),
    ).toMatchObject({ currentModeId: "ask" });
  });
});

describe("WebSocket JSON 载荷解码", () => {
  // 文本对象帧应解码为协议对象。
  test("解析 UTF-8 字符串对象", () => {
    expect(decodeJsonWsMessage('{"type":"ping","text":"你好"}')).toEqual({ type: "ping", text: "你好" });
  });

  // ArrayBuffer 是浏览器 WebSocket 常见的二进制帧形态。
  test("解析 ArrayBuffer 对象帧", () => {
    const bytes = new TextEncoder().encode('{"id":1}');
    expect(decodeJsonWsMessage(bytes.buffer)).toEqual({ id: 1 });
  });

  // DataView 必须遵守自身 offset，不能读取相邻字节。
  test("解析带偏移量的 ArrayBufferView", () => {
    const bytes = new TextEncoder().encode('x{"ok":true}y');
    expect(decodeJsonWsMessage(new DataView(bytes.buffer, 1, bytes.byteLength - 2))).toEqual({ ok: true });
  });

  // Node Buffer 是服务端 WebSocket 常见的二进制帧形态。
  test("解析 Buffer 对象帧", () => {
    expect(decodeJsonWsMessage(Buffer.from('{"source":"buffer"}'))).toEqual({ source: "buffer" });
  });

  // 分片 Buffer 数组应按顺序合并后再解析。
  test("解析分片 Buffer 对象帧", () => {
    expect(decodeJsonWsMessage([Buffer.from('{"part":'), Buffer.from("2}")])).toEqual({ part: 2 });
  });

  // JSON 数组不是协议对象，必须拒绝而非默默接受。
  test("拒绝 JSON 数组载荷", () => {
    expect(() => decodeJsonWsMessage("[]")).toThrow("Invalid WebSocket message payload");
  });

  // JSON 标量不是协议对象，必须拒绝而非默默接受。
  test("拒绝 JSON 标量载荷", () => {
    expect(() => decodeJsonWsMessage('"pong"')).toThrow("Invalid WebSocket message payload");
  });

  // 无法解析的文本必须将 JSON 错误传递给调用方。
  test("拒绝损坏的 JSON 文本", () => {
    expect(() => decodeJsonWsMessage("{not-json}")).toThrow();
  });

  // 非支持帧类型不得被隐式字符串化。
  test("拒绝不支持的载荷类型", () => {
    expect(() => decodeJsonWsMessage(42)).toThrow("Unsupported WebSocket message payload");
  });

  // 恰好达到上限的有效载荷仍属于允许范围。
  test("接受恰好等于载荷上限的文本", () => {
    const payload = `{"data":"${"a".repeat(MAX_CLIENT_WS_PAYLOAD_BYTES - 11)}"}`;
    expect(Buffer.byteLength(payload)).toBe(MAX_CLIENT_WS_PAYLOAD_BYTES);
    expect(decodeJsonWsMessage(payload).data).toHaveLength(MAX_CLIENT_WS_PAYLOAD_BYTES - 11);
  });

  // 超过上限必须在 JSON 解析前拒绝，避免内存压力扩大。
  test("拒绝超过上限的文本载荷", () => {
    const payload = `{"data":"${"a".repeat(MAX_CLIENT_WS_PAYLOAD_BYTES - 10)}"}`;
    expect(() => decodeJsonWsMessage(payload)).toThrow(WsPayloadTooLargeError);
  });

  // 专用错误类型需保留字节数，便于上层记录安全诊断信息。
  test("超限错误包含载荷字节数", () => {
    const error = new WsPayloadTooLargeError(123);
    expect(error.name).toBe("WsPayloadTooLargeError");
    expect(error.message).toBe("WebSocket message too large: 123 bytes");
  });
});
