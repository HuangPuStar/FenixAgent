/**
 * LlmToolNode — 通用 LLM 调用节点。
 *
 * 对接 OpenAI 兼容 API，支持返回纯文本或结构化 JSON。
 * 模型、API 地址、API Key 可从 YAML inputs / secrets / 环境变量
 * 三层降级获取，敏感信息优先走 secrets。
 *
 * YAML 示例:
 *   - id: classify_sample
 *     type: custom
 *     tool: llm
 *     inputs:
 *       user_prompt: "分类样本: ${{ params.sample_name }}"
 *       system_prompt: "你是生物信息分类助手，只输出 JSON"
 *       model: "gpt-4o-mini"
 *       temperature: "0.3"
 *       response_format: json_object
 *     outputs:
 *       result:
 *         pattern: ""
 *         type: file
 *
 * Secrets 示例（在 workflow 顶层声明）:
 *   secrets:
 *     - OPENAI_API_KEY
 */

import type { CustomNode, ExecuteContext, InputDef, NodeOutput } from "@fenix/workflow-engine";

export default class LlmToolNode implements CustomNode {
  name = "llm";
  kind = "default" as const;
  description = "调用 OpenAI 兼容 API 进行大模型推理，支持返回 JSON 或纯文本";

  inputs: Record<string, InputDef> = {
    user_prompt: {
      type: "string",
      required: true,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 工作流模板语法 ${{ }}
      description: "用户提示词，支持 ${{ }} 表达式引用上游输出或 params",
    },
    system_prompt: {
      type: "string",
      required: false,
      description: "系统提示词（设定模型角色与行为）",
    },
    model: {
      type: "string",
      required: false,
      description: "模型名称，默认 gpt-4o。支持任意 OpenAI 兼容模型（如 deepseek-chat, qwen-plus）",
    },
    temperature: {
      type: "number",
      required: false,
      description: "采样温度 (0-2)，默认 0.7。越低越确定，越高越随机",
      group: "advance",
    },
    max_tokens: {
      type: "number",
      required: false,
      description: "最大输出 token 数，不设则用模型默认上限",
      group: "advance",
    },
    response_format: {
      type: "string",
      required: false,
      description: '响应格式: "text"（默认，返回纯文本）或 "json_object"（返回 JSON）',
    },
    api_key: {
      type: "string",
      required: false,
      description: "OpenAI API Key。优先级高于 secrets 和环境变量，建议走 secrets 声明以避免硬编码",
      group: "advance",
    },
    output_contains: {
      type: "string",
      required: false,
      description: "输出必须包含的文本。设置后若 LLM 返回内容中不包含该文本，节点标记为失败 (FAILED)",
      group: "advance",
    },
    api_base: {
      type: "string",
      required: false,
      description: "API 基础地址，默认 https://api.openai.com/v1。设置后对接任意 OpenAI 兼容服务",
      group: "advance",
    },
  };

  produces = ["*"];

  /** LLM 节点颜色 — 翠绿 */
  color = "#059669";

  /** LLM 推理依赖的环境变量 */
  env = ["OPENAI_API_KEY", "OPENAI_API_BASE"];

  async execute(ctx: ExecuteContext): Promise<NodeOutput> {
    // ── 解析配置: inputs 优先 → secrets → 环境变量 → 硬编码默认值 ──
    const model = (ctx.inputs.model as string) || "gpt-4o";
    const temperature = ctx.inputs.temperature != null ? Number(ctx.inputs.temperature) : 0.7;
    const maxTokens = ctx.inputs.max_tokens != null ? Number(ctx.inputs.max_tokens) : undefined;
    const responseFormat = (ctx.inputs.response_format as string) || "text";
    const systemPrompt = ctx.inputs.system_prompt as string | undefined;
    const userPrompt = ctx.inputs.user_prompt as string | undefined;

    if (!userPrompt?.trim()) {
      throw new Error("LlmNode: user_prompt is required and must be non-empty");
    }

    // API Key: inputs > secrets > env（敏感信息避免硬编码在 YAML）
    const apiKey = (ctx.inputs.api_key as string) || ctx.secrets.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "LlmNode: OpenAI API key not found. " +
          "Set it via inputs.api_key, secrets.OPENAI_API_KEY, or OPENAI_API_KEY env variable.",
      );
    }

    const apiBase =
      (ctx.inputs.api_base as string) ||
      ctx.secrets.OPENAI_API_BASE ||
      process.env.OPENAI_API_BASE ||
      "https://api.openai.com/v1";

    // ── 构建 messages ──
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: userPrompt });

    // ── 构建请求体 ──
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
    };
    if (maxTokens) body.max_tokens = maxTokens;
    if (responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }

    // ── 调用 OpenAI 兼容 API ──
    const url = `${apiBase.replace(/\/$/, "")}/chat/completions`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (err) {
      throw new Error(`LlmNode: network error calling ${url}: ${(err as Error).message}`);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "(unable to read error body)");
      throw new Error(`LlmNode: API error (${response.status}) from ${url}: ${errorText.slice(0, 500)}`);
    }

    const data = await response.json().catch(() => {
      throw new Error(`LlmNode: failed to parse JSON response from ${url}`);
    });
    const content: string = data.choices?.[0]?.message?.content ?? "";

    // ── 输出校验规则: output_contains 不为空时，内容必须包含指定文本 ──
    const outputContains = ctx.inputs.output_contains as string | undefined;
    if (outputContains && !content.includes(outputContains)) {
      throw new Error(
        `LlmNode: output validation failed — LLM response does not contain required text "${outputContains}". Response: ${content.slice(0, 200)}`,
      );
    }

    // ── 按 response_format 决定 stdout/json ──
    let json: unknown;
    if (responseFormat === "json_object" && content) {
      try {
        json = JSON.parse(content);
      } catch {
        // JSON 解析失败不阻塞: stdout 保留原始文本, json 为 undefined
      }
    }

    return {
      stdout: content,
      json,
      exit_code: 0,
      size: new TextEncoder().encode(content).length,
    };
  }
}
