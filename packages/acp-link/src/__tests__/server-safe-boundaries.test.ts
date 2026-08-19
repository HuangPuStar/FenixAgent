import { describe, expect, test } from "bun:test";
import {
  ACP_METHOD,
  createErrorResponse,
  createNotification,
  createRequest,
  createSuccessResponse,
  isJsonRpcMessage,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isTransportMessage,
} from "../json-rpc.js";
import { buildRegisterMessage, MAX_CLIENT_WS_PAYLOAD_BYTES, type ServerConfig } from "../server.js";
import { decodeJsonWsMessage, WsPayloadTooLargeError } from "../ws-message.js";

const baseConfig: ServerConfig = {
  port: 9315,
  host: "127.0.0.1",
  command: "opencode",
  args: ["serve"],
  cwd: "/workspace",
};

function registerMessage(config: ServerConfig = baseConfig, nodeId?: string | null): Record<string, unknown> {
  return buildRegisterMessage(config, nodeId) as Record<string, unknown>;
}

describe("server 注册消息安全边界", () => {
  // 注册帧必须声明固定的注册类型，避免被服务端识别为其他控制帧。
  test("生成 register 类型消息", () => {
    expect(registerMessage().type).toBe("register");
  });

  // agent_name 只能来自本地启动命令，不能被 host 或 cwd 混入。
  test("使用命令作为 agent_name", () => {
    expect(registerMessage().agent_name).toBe("opencode");
  });

  // 未指定显示名时显式发送 null，使服务端不会把 undefined 序列化为歧义字段。
  test("缺少名称时发送 null", () => {
    expect(registerMessage().name).toBeNull();
  });

  // 自定义机器名需要原样进入注册帧。
  test("保留自定义机器名称", () => {
    expect(registerMessage({ ...baseConfig, name: "开发机" }).name).toBe("开发机");
  });

  // 注册容量是代理端协议常量，避免配置输入意外扩大资源声明。
  test("使用固定最大会话数", () => {
    expect(registerMessage().max_sessions).toBe(5);
  });

  // 注册帧必须声明流式能力供服务端选择正确传输路径。
  test("声明 streaming 能力", () => {
    expect(registerMessage().capabilities).toEqual({ streaming: true });
  });

  // 未提供 labels 时应发送空数组而不是 null。
  test("缺少标签时发送空数组", () => {
    expect(registerMessage().labels).toEqual([]);
  });

  // 标签顺序是调用方语义，注册时不可重排。
  test("保留标签顺序", () => {
    expect(registerMessage({ ...baseConfig, labels: ["gpu", "internal"] }).labels).toEqual(["gpu", "internal"]);
  });

  // 空标签数组是合法且应稳定保留的输入。
  test("保留显式空标签数组", () => {
    expect(registerMessage({ ...baseConfig, labels: [] }).labels).toEqual([]);
  });

  // 心跳间隔是协议字段，必须与服务端期望单位毫秒一致。
  test("使用 30 秒心跳间隔", () => {
    expect(registerMessage().heartbeat_interval_ms).toBe(30_000);
  });

  // 缺少租户身份时以 null 表示匿名上下文。
  test("缺少 tenantId 时发送 null", () => {
    expect(registerMessage().tenant_id).toBeNull();
  });

  // 租户身份需要无损透传到注册帧。
  test("保留 tenantId", () => {
    expect(registerMessage({ ...baseConfig, tenantId: "tenant-a" }).tenant_id).toBe("tenant-a");
  });

  // 缺少用户身份时以 null 表示，避免把 undefined 误当成字符串。
  test("缺少 userId 时发送 null", () => {
    expect(registerMessage().user_id).toBeNull();
  });

  // 用户身份需要无损透传到注册帧。
  test("保留 userId", () => {
    expect(registerMessage({ ...baseConfig, userId: "user-a" }).user_id).toBe("user-a");
  });

  // 持久化 nodeId 仅在非空时发送，避免覆盖服务端已有标识。
  test("保留非空 nodeId", () => {
    expect(registerMessage(baseConfig, "node-1").node_id).toBe("node-1");
  });

  // 空 nodeId 不得进入注册帧。
  test("忽略空 nodeId", () => {
    expect("node_id" in registerMessage(baseConfig, "")).toBe(false);
  });

  // null nodeId 不得进入注册帧。
  test("忽略 null nodeId", () => {
    expect("node_id" in registerMessage(baseConfig, null)).toBe(false);
  });

  // 固定 machineId 必须进入独立字段，不能与持久化 nodeId 混淆。
  test("保留固定 machineId", () => {
    expect(registerMessage({ ...baseConfig, machineId: "machine-1" }).machine_id).toBe("machine-1");
  });

  // nodeId 与 machineId 同时存在时都应保留，支持精确重连和固定机器标识。
  test("同时保留 nodeId 与 machineId", () => {
    const message = registerMessage({ ...baseConfig, machineId: "machine-1" }, "node-1");
    expect(message.node_id).toBe("node-1");
    expect(message.machine_id).toBe("machine-1");
  });

  // 自定义引擎清单必须完整透传，确保服务端据此调度实例。
  test("保留自定义支持引擎", () => {
    const engines = [{ type: "ccb", cliPath: "/usr/local/bin/ccb" }, { type: "opencode" }];
    expect(registerMessage({ ...baseConfig, supportedEngineTypes: engines }).supported_engine_types).toEqual(engines);
  });

  // machine_info 必须含有所有协议要求的机器属性。
  test("生成完整 machine_info", () => {
    expect(registerMessage().machine_info).toEqual(
      expect.objectContaining({
        hostname: expect.any(String),
        ip: expect.any(String),
        mac: expect.any(String),
        os: expect.any(String),
        arch: expect.any(String),
      }),
    );
  });
});

describe("服务端 JSON-RPC 请求验证与错误映射", () => {
  // 请求工厂必须固定 JSON-RPC 版本。
  test("创建请求时固定 JSON-RPC 版本", () => {
    expect(createRequest(ACP_METHOD.SESSION_NEW).jsonrpc).toBe("2.0");
  });

  // 连续请求必须拥有不同 id，避免并发响应串线。
  test("连续请求生成不同 id", () => {
    expect(createRequest("a").id).not.toBe(createRequest("b").id);
  });

  // 缺省 params 要规范化为空对象，减少 handler 空值分支。
  test("缺省请求参数规范化为空对象", () => {
    expect(createRequest("a").params).toEqual({});
  });

  // 显式参数必须原样保留给路由处理器。
  test("保留显式请求参数", () => {
    expect(createRequest("a", { sessionId: "s1" }).params).toEqual({ sessionId: "s1" });
  });

  // 通知没有 id，防止被当作需要响应的请求。
  test("创建通知时不含 id", () => {
    expect("id" in createNotification(ACP_METHOD.SESSION_UPDATE)).toBe(false);
  });

  // 通知可安全携带未定义参数。
  test("通知保留未定义参数", () => {
    expect(createNotification("notice").params).toBeUndefined();
  });

  // 成功响应要关联原始数值请求 id。
  test("成功响应保留数值 id", () => {
    expect(createSuccessResponse(7, { ok: true })).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  });

  // 成功响应要关联原始字符串请求 id。
  test("成功响应保留字符串 id", () => {
    expect(createSuccessResponse("req-7", null).id).toBe("req-7");
  });

  // 错误响应必须保留标准错误码。
  test("错误响应保留 RPC 错误码", () => {
    expect(createErrorResponse(1, -32601, "Method not found").error.code).toBe(-32601);
  });

  // 无法关联请求的错误可使用 null id。
  test("错误响应支持 null id", () => {
    expect(createErrorResponse(null, -32600, "Invalid Request").id).toBeNull();
  });

  // 仅版本正确的对象才属于 JSON-RPC，避免普通 transport 帧误入 RPC 分派。
  test("识别合法 JSON-RPC 消息", () => {
    expect(isJsonRpcMessage({ jsonrpc: "2.0", method: "x" })).toBe(true);
  });

  // 错误版本不得进入 RPC 路由。
  test("拒绝错误 JSON-RPC 版本", () => {
    expect(isJsonRpcMessage({ jsonrpc: "1.0", method: "x" })).toBe(false);
  });

  // null 不是可路由的 JSON-RPC 消息。
  test("拒绝 null JSON-RPC 输入", () => {
    expect(isJsonRpcMessage(null)).toBe(false);
  });

  // 基元值不是可路由的 JSON-RPC 消息。
  test("拒绝字符串 JSON-RPC 输入", () => {
    expect(isJsonRpcMessage('{"jsonrpc":"2.0"}')).toBe(false);
  });

  // 有 method 和 id 的 JSON-RPC 消息应路由为请求。
  test("识别带 id 的 RPC 请求", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "session/new" })).toBe(true);
  });

  // 无 id 的 method 消息不能路由为请求。
  test("拒绝无 id 的 RPC 请求", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0", method: "session/new" })).toBe(false);
  });

  // 无 id 的 method 消息应路由为通知。
  test("识别 RPC 通知", () => {
    expect(isJsonRpcNotification({ jsonrpc: "2.0", method: ACP_METHOD.SESSION_UPDATE })).toBe(true);
  });

  // 含 id 的消息不是通知，避免响应循环。
  test("带 id 消息不是 RPC 通知", () => {
    expect(isJsonRpcNotification({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(false);
  });

  // result 响应应被识别以便权限结果回传。
  test("识别 RPC 成功响应", () => {
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: "p1", result: {} })).toBe(true);
  });

  // error 响应应被识别以便错误路径消费。
  test("识别 RPC 错误响应", () => {
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: "p1", error: { code: -32603, message: "failed" } })).toBe(true);
  });

  // 只有 id 而没有 result/error 的消息不能被误判为响应。
  test("拒绝不完整 RPC 响应", () => {
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: "p1" })).toBe(false);
  });

  // 已知 transport 类型应在 RPC 前被分流。
  test("识别 connect transport 帧", () => {
    expect(isTransportMessage({ type: "connect" })).toBe(true);
  });

  // 前端断连清理帧必须被识别，确保待决权限可及时释放。
  test("识别取消待决权限 transport 帧", () => {
    expect(isTransportMessage({ type: "cancel_pending_permissions" })).toBe(true);
  });

  // 未知 type 不能取得 transport 特权。
  test("拒绝未知 transport 类型", () => {
    expect(isTransportMessage({ type: "admin" })).toBe(false);
  });

  // 非对象输入不能取得 transport 特权。
  test("拒绝基元 transport 输入", () => {
    expect(isTransportMessage("connect")).toBe(false);
  });
});

describe("服务端 WebSocket 输入安全", () => {
  // 文本 JSON 对象应被解码为可供路由的记录。
  test("解码文本 JSON 对象", () => {
    expect(decodeJsonWsMessage('{"type":"ping"}')).toEqual({ type: "ping" });
  });

  // ArrayBuffer 是浏览器 WebSocket 的合法二进制载荷。
  test("解码 ArrayBuffer JSON", () => {
    const bytes = new TextEncoder().encode('{"type":"ping"}');
    expect(decodeJsonWsMessage(bytes.buffer)).toEqual({ type: "ping" });
  });

  // Uint8Array 是 Node WebSocket 的常见二进制载荷。
  test("解码 Uint8Array JSON", () => {
    expect(decodeJsonWsMessage(new TextEncoder().encode('{"type":"ping"}'))).toEqual({ type: "ping" });
  });

  // Buffer 分片是 ws 库的合法输入形式。
  test("解码 Buffer 分片 JSON", () => {
    expect(decodeJsonWsMessage([Buffer.from('{"type":'), Buffer.from('"ping"}')])).toEqual({ type: "ping" });
  });

  // JSON 数组不能冒充协议对象。
  test("拒绝 JSON 数组载荷", () => {
    expect(() => decodeJsonWsMessage("[]")).toThrow("Invalid WebSocket message payload");
  });

  // JSON null 不能冒充协议对象。
  test("拒绝 JSON null 载荷", () => {
    expect(() => decodeJsonWsMessage("null")).toThrow("Invalid WebSocket message payload");
  });

  // 损坏 JSON 必须在路由前失败。
  test("拒绝损坏 JSON", () => {
    expect(() => decodeJsonWsMessage("{")).toThrow();
  });

  // 不支持的运行时对象必须在路由前失败。
  test("拒绝不支持的载荷类型", () => {
    expect(() => decodeJsonWsMessage({ type: "ping" })).toThrow("Unsupported WebSocket message payload");
  });

  // 精确上限的载荷允许通过，避免边界 off-by-one 拒绝。
  test("接受精确大小上限的文本载荷", () => {
    const payload = `{"data":"${"x".repeat(MAX_CLIENT_WS_PAYLOAD_BYTES - 11)}"}`;
    expect(decodeJsonWsMessage(payload).data).toHaveLength(MAX_CLIENT_WS_PAYLOAD_BYTES - 11);
  });

  // 超过上限的文本载荷必须映射为专用错误，供 server 关闭连接。
  test("拒绝超过上限的文本载荷", () => {
    const payload = `{"data":"${"x".repeat(MAX_CLIENT_WS_PAYLOAD_BYTES - 10)}"}`;
    expect(() => decodeJsonWsMessage(payload)).toThrow(WsPayloadTooLargeError);
  });

  // 超限的 ArrayBuffer 也必须使用同一专用错误。
  test("拒绝超过上限的 ArrayBuffer 载荷", () => {
    expect(() => decodeJsonWsMessage(new ArrayBuffer(MAX_CLIENT_WS_PAYLOAD_BYTES + 1))).toThrow(WsPayloadTooLargeError);
  });

  // 超限的 Buffer 分片总长度必须累计校验，不能逐块绕过限制。
  test("拒绝累计超过上限的 Buffer 分片", () => {
    expect(() => decodeJsonWsMessage([Buffer.alloc(MAX_CLIENT_WS_PAYLOAD_BYTES), Buffer.from("x")])).toThrow(
      WsPayloadTooLargeError,
    );
  });

  // 专用错误名称稳定，供 server 的 close(1009) 分支可靠识别。
  test("超限错误具有稳定名称", () => {
    expect(new WsPayloadTooLargeError(1).name).toBe("WsPayloadTooLargeError");
  });

  // 超限错误应包含字节数，便于受控日志诊断而不泄露载荷内容。
  test("超限错误包含字节长度", () => {
    expect(new WsPayloadTooLargeError(123).message).toContain("123 bytes");
  });
});
