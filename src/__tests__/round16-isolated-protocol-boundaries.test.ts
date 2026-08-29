import { afterEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { ApiMcpListQuerySchema } from "../schemas/api-mcp.schema";
import { PaginationParamsSchema } from "../schemas/common.schema";
import { composeAgentSystemPrompt, DEFAULT_AGENT_SYSTEM_PROMPT } from "../services/agent-system-prompt";
import { classifyPermanentSpawnFailure, isMachineOfflineError } from "../services/chat-channel-error-classify";
import {
  configError,
  configNotFound,
  configSuccess,
  configValidationError,
  isValidResourceName,
  resolveApiKey,
  safeJsonParse,
  safeJsonStringify,
  toKeyHint,
} from "../services/config-utils";
import {
  buildOpenAIError,
  mapToNonStreamingResponse,
  mapToSSEChunks,
  type RelayEvent,
} from "../services/openai-response-mapper";

type EnvironmentSnapshot = { value: string | undefined };
const apiKeyEnvironmentName = "FENIX_ROUND16_TEST_API_KEY";
let apiKeyEnvironment: EnvironmentSnapshot = { value: undefined };

function sessionUpdate(update: Record<string, unknown>): RelayEvent {
  return {
    type: "session_data",
    payload: { jsonrpc: "2.0", method: "session/update", params: { update } },
  };
}

function completion(stopReason: string): RelayEvent {
  return { type: "session_data", payload: { jsonrpc: "2.0", result: { stopReason } } };
}

async function collectChunks(
  events: AsyncIterable<RelayEvent>,
  signal?: AbortSignal,
  onStopReason?: (reason: string) => void,
) {
  const chunks: string[] = [];
  for await (const chunk of mapToSSEChunks(events, "agent-round16", signal, onStopReason)) {
    chunks.push(chunk);
  }
  return chunks;
}

async function* eventStream(events: RelayEvent[]): AsyncGenerator<RelayEvent> {
  for (const event of events) {
    yield event;
  }
}

afterEach(() => {
  if (apiKeyEnvironment.value === undefined) {
    delete process.env[apiKeyEnvironmentName];
  } else {
    process.env[apiKeyEnvironmentName] = apiKeyEnvironment.value;
  }
  apiKeyEnvironment = { value: undefined };
});

describe("round16 isolated protocol and boundary coverage", () => {
  // 默认模板必须同时注入产品身份与用户提示词。
  test("默认系统提示词替换两个占位符", () => {
    const result = composeAgentSystemPrompt(DEFAULT_AGENT_SYSTEM_PROMPT, "客服 Agent", "  回答订单问题  ");

    expect(result).toContain("客服 Agent");
    expect(result).toContain("回答订单问题");
    expect(result).not.toContain("{{userPrompt}}");
  });

  // 已声明用户提示词位置的模板不得重复追加段落。
  test("显式用户提示词占位符不追加兜底段落", () => {
    expect(composeAgentSystemPrompt("身份: {{agentName}}\n{{userPrompt}}", "A", "内容")).toBe("身份: A\n内容");
  });

  // 空用户提示词在显式模板中应移除占位符并收尾空白。
  test("显式模板接受空用户提示词", () => {
    expect(composeAgentSystemPrompt("  {{agentName}}: {{userPrompt}}  ", "A", null)).toBe("A:");
  });

  // 未声明占位符时必须保留自定义模板并追加用户提示词。
  test("未声明用户占位符时追加兜底段落", () => {
    expect(composeAgentSystemPrompt("规则 {{agentName}}", "A", "用户规则")).toBe("规则 A\n\n## User Prompt\n用户规则");
  });

  // 空白用户提示词不能产生无意义的兜底段落。
  test("未声明占位符且用户提示为空时不追加内容", () => {
    expect(composeAgentSystemPrompt("规则 {{agentName}}", "A", "  ")).toBe("规则 A");
  });

  // 成功配置响应必须保持调用方数据原样。
  test("配置成功响应封装业务数据", () => {
    expect(configSuccess({ id: "resource-1" })).toEqual({ success: true, data: { id: "resource-1" } });
  });

  // 错误响应不应凭空携带 data 字段。
  test("配置错误响应省略未提供的数据", () => {
    expect(configError("INVALID", "无效")).toEqual({ success: false, error: { code: "INVALID", message: "无效" } });
  });

  // 错误响应应允许返回安全的附加诊断数据。
  test("配置错误响应保留显式附加数据", () => {
    expect(configError("INVALID", "无效", { field: "name" })).toEqual({
      success: false,
      error: { code: "INVALID", message: "无效" },
      data: { field: "name" },
    });
  });

  // 未找到资源应统一映射为 NOT_FOUND。
  test("配置未找到响应使用固定错误码", () => {
    expect(configNotFound("Agent 不存在")).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Agent 不存在" },
    });
  });

  // 参数校验失败应统一映射为 VALIDATION_ERROR。
  test("配置校验响应使用固定错误码", () => {
    expect(configValidationError("名称不合法").error.code).toBe("VALIDATION_ERROR");
  });

  // 合法 Unicode 名称可以包含单个连字符和空格。
  test("资源名称接受 Unicode 字母数字与单连字符", () => {
    expect(isValidResourceName("知识库-2026 A")).toBe(true);
  });

  // 资源名称边界必须拒绝连续连字符、首尾空格和超长值。
  test("资源名称拒绝危险或越界格式", () => {
    expect(isValidResourceName("a--b")).toBe(false);
    expect(isValidResourceName(" a")).toBe(false);
    expect(isValidResourceName("a".repeat(65))).toBe(false);
  });

  // 环境变量引用只在变量存在时解析，避免把引用文本当作密钥使用。
  test("API Key 环境引用解析为当前环境值", () => {
    apiKeyEnvironment = { value: process.env[apiKeyEnvironmentName] };
    process.env[apiKeyEnvironmentName] = "round16-key";

    expect(resolveApiKey(`{env:${apiKeyEnvironmentName}}`)).toBe("round16-key");
  });

  // 缺失环境变量必须返回 null，防止传递不存在的凭据。
  test("缺失的 API Key 环境引用返回空值", () => {
    expect(resolveApiKey(`{env:${apiKeyEnvironmentName}}`)).toBeNull();
  });

  // 直接密钥与空值需要有确定的解析语义。
  test("API Key 直接值与空值分别处理", () => {
    expect(resolveApiKey("plain-key")).toBe("plain-key");
    expect(resolveApiKey("")).toBeNull();
    expect(resolveApiKey(null)).toBeNull();
  });

  // Key hint 仅暴露前四位和后三位，短密钥统一掩码。
  test("API Key 提示掩码不泄露完整密钥", () => {
    expect(toKeyHint("abcdefgh")).toBe("abcd***fgh");
    expect(toKeyHint("abc")).toBe("*******");
    expect(toKeyHint(null)).toBe("*******");
  });

  // JSON 序列化应保留 false 与零等有效值。
  test("JSON 安全序列化保留有效假值", () => {
    expect(safeJsonStringify(false)).toBe("false");
    expect(safeJsonStringify(0)).toBe("0");
  });

  // 空值不应写入 JSONB，非法 JSON 也不能中断请求。
  test("JSON 安全处理空值和非法输入", () => {
    expect(safeJsonStringify(null)).toBeUndefined();
    expect(safeJsonParse<{ id: string }>("{")).toBeNull();
    expect(safeJsonParse<{ id: string }>(null)).toBeNull();
  });

  // JSON 反序列化应恢复调用方指定的数据形状。
  test("JSON 安全反序列化有效对象", () => {
    expect(safeJsonParse<{ id: string }>('{"id":"one"}')).toEqual({ id: "one" });
  });

  // 原始 JSON-RPC 事件也必须被协议映射器识别。
  test("非流式映射接受原始 JSON-RPC 事件", () => {
    const response = mapToNonStreamingResponse(
      [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "原始事件" } } },
        } as unknown as RelayEvent,
      ],
      "agent-round16",
    );

    expect(response.choices[0].message.content).toBe("原始事件");
    expect(response.choices[0].finish_reason).toBe("end_turn");
  });

  // 无效协议包不能污染 OpenAI 响应内容。
  test("非流式映射忽略无效协议事件", () => {
    const response = mapToNonStreamingResponse([{ type: "other", payload: { value: "ignored" } }], "agent-round16");

    expect(response.choices[0].message.content).toBe("");
  });

  // 未知 session update 仅作为空 reasoning，不得伪造正文。
  test("非流式映射忽略未知更新类型", () => {
    const response = mapToNonStreamingResponse([sessionUpdate({ sessionUpdate: "unknown_update" })], "agent-round16");

    expect(response.choices[0].message.content).toBe("");
    expect(response.choices[0].message.reasoning_content).toBeUndefined();
  });

  // 流式思考块必须进入 reasoning_content delta。
  test("流式映射输出思考增量", async () => {
    const chunks = await collectChunks(
      eventStream([
        sessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "分析" } }),
        completion("stop"),
      ]),
    );

    expect(chunks[0]).toContain('"reasoning_content":"分析"');
    expect(chunks).toContain("data: [DONE]\n\n");
  });

  // 流式工具调用必须向客户端暴露约定的简化协议文本。
  test("流式映射输出工具调用增量", async () => {
    const chunks = await collectChunks(
      eventStream([sessionUpdate({ sessionUpdate: "tool_call", title: "search" }), completion("end_turn")]),
    );

    expect(chunks[0]).toContain('<tool_call name=\\"search\\" />');
  });

  // 缺少标题的工具调用必须使用 unknown，防止空 XML 属性。
  test("流式工具调用为缺失标题提供默认值", async () => {
    const chunks = await collectChunks(
      eventStream([sessionUpdate({ sessionUpdate: "tool_call_update" }), completion("end_turn")]),
    );

    expect(chunks[0]).toContain('<tool_result name=\\"unknown\\" />');
  });

  // 完成事件应该只发送一次终态并透传结束原因。
  test("流式映射透传完成原因并结束", async () => {
    const reasons: string[] = [];
    const chunks = await collectChunks(
      eventStream([
        completion("cancelled"),
        sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "不得发送" } }),
      ]),
      undefined,
      (reason) => reasons.push(reason),
    );

    expect(reasons).toEqual(["cancelled"]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('"finish_reason":"cancelled"');
  });

  // 流自然结束也必须释放客户端等待并补发终态。
  test("流式映射在无完成事件时补发终态", async () => {
    const chunks = await collectChunks(eventStream([]));

    expect(chunks).toEqual(
      expect.arrayContaining([expect.stringContaining('"finish_reason":"end_turn"'), "data: [DONE]\n\n"]),
    );
  });

  // 已取消的请求不得继续消费或向客户端写入事件。
  test("流式映射在取消信号后立即释放", async () => {
    const controller = new AbortController();
    controller.abort();
    const chunks = await collectChunks(
      eventStream([
        sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "取消后内容" } }),
      ]),
      controller.signal,
    );

    expect(chunks).toEqual(
      expect.arrayContaining([expect.stringContaining('"finish_reason":"end_turn"'), "data: [DONE]\n\n"]),
    );
    expect(chunks.join("")).not.toContain("取消后内容");
  });

  // OpenAI 错误体只应在 401 时暴露 invalid_api_key 语义。
  test("OpenAI 错误映射区分认证失败与其他错误", () => {
    expect(buildOpenAIError(401, "认证失败", "authentication_error").body.error.code).toBe("invalid_api_key");
    expect(buildOpenAIError(500, "内部失败", "server_error").body.error.code).toBeUndefined();
  });

  // 机器离线 AppError 应阻止无意义的自动重连。
  test("机器离线 AppError 被识别为离线", () => {
    expect(isMachineOfflineError(new AppError("离线", "MACHINE_OFFLINE"))).toBe(true);
  });

  // 非机器错误不能误触发离线终态。
  test("普通错误不被识别为机器离线", () => {
    expect(isMachineOfflineError(new Error("网络波动"))).toBe(false);
  });

  // 两种配置性永久失败应返回稳定的客户端诊断码。
  test("永久 spawn 失败映射为稳定诊断码", () => {
    expect(classifyPermanentSpawnFailure(new AppError("禁用", "AUTO_START_DISABLED"))).toBe("auto_start_disabled");
    expect(classifyPermanentSpawnFailure(new AppError("已满", "MAX_SESSIONS_REACHED"))).toBe("max_sessions_reached");
  });

  // MCP 分页参数应把字符串查询安全转换为受限整数。
  test("MCP 分页查询转换并采用默认值", () => {
    expect(ApiMcpListQuerySchema.parse({ page: "2", pageSize: "100" })).toEqual({ page: 2, pageSize: 100 });
    expect(ApiMcpListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
  });

  // MCP 分页参数必须拒绝零、负数、超限和非整数，避免越界查询。
  test("MCP 分页查询拒绝无效边界", () => {
    expect(ApiMcpListQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(ApiMcpListQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(ApiMcpListQuerySchema.safeParse({ page: "1.5" }).success).toBe(false);
  });

  // 通用分页允许省略参数，并提供稳定的默认窗口。
  test("通用分页参数提供默认窗口", () => {
    expect(PaginationParamsSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
  });

  // 通用分页必须拒绝负页码与过大页面，避免数据访问层接收非法输入。
  test("通用分页参数拒绝越界输入", () => {
    expect(PaginationParamsSchema.safeParse({ page: -1 }).success).toBe(false);
    expect(PaginationParamsSchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });

  // 未知失败必须保留可重试语义。
  test("未知 spawn 失败保持可重试", () => {
    expect(classifyPermanentSpawnFailure(new AppError("暂时失败", "INTERNAL_ERROR"))).toBeNull();
    expect(classifyPermanentSpawnFailure(new Error("暂时失败"))).toBeNull();
  });
});
