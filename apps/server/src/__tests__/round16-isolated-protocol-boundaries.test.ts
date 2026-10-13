import { afterEach, describe, expect, test } from "bun:test";
import { composeAgentSystemPrompt, DEFAULT_AGENT_SYSTEM_PROMPT } from "@fenix/agent-config/server/system-prompt";
import { classifyPermanentSpawnFailure, isMachineOfflineError } from "@fenix/chat-channel/server";
import { AppError, PaginationParamsSchema } from "@fenix/platform-sdk";
import { ApiMcpListQuerySchema } from "@fenix/resource-mcp/server/schema";
import { resolveApiKey } from "../services/config-utils";

type EnvironmentSnapshot = { value: string | undefined };
const apiKeyEnvironmentName = "FENIX_ROUND16_TEST_API_KEY";
let apiKeyEnvironment: EnvironmentSnapshot = { value: undefined };

afterEach(() => {
  if (apiKeyEnvironment.value === undefined) {
    delete process.env[apiKeyEnvironmentName];
  } else {
    process.env[apiKeyEnvironmentName] = apiKeyEnvironment.value;
  }
  apiKeyEnvironment = { value: undefined };
});

/**
 * round16 协议与输入边界的隔离用例。
 *
 * 本文件原有的 `/web/config/*` 共享工具断言（响应信封、资源名校验、密钥提示、JSON 安全转换）随宿主
 * `services/config-utils.ts` 的信封函数在任务 1.5c 删除：那些函数的消费方是已迁入资源包的旧路由，
 * 宿主副本零生产消费方，行为由包内实现（`@fenix/model-management` 的 `config-envelope.ts`、
 * `@fenix/agent-config` 的 `isValidAgentName`）的用例覆盖。保留 `resolveApiKey`：它是宿主仍要注入的
 * 密钥引用解析（见 `services/resource-module-ports.ts`）。
 */
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

  // 机器离线 AppError 应阻止无意义的自动重连。
  test("机器离线 AppError 被识别为离线", () => {
    expect(isMachineOfflineError(new AppError("离线", "MACHINE_OFFLINE"))).toBe(true);
  });

  // 非机器错误不能误触发离线终态。
  test("普通错误不被识别为机器离线", () => {
    expect(isMachineOfflineError(new Error("网络波动"))).toBe(false);
  });

  // 配置性永久失败应返回稳定的客户端诊断码。
  test("永久 spawn 失败映射为稳定诊断码", () => {
    expect(classifyPermanentSpawnFailure(new AppError("禁用", "AUTO_START_DISABLED"))).toBe("auto_start_disabled");
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
