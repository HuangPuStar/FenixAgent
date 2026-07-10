import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";

// 直接测试表单 Schema（与 TaskForm 中定义的一致）
const formSchema = z
  .object({
    type: z.enum(["http", "agent"]),
    name: z.string().min(1, "名称不能为空"),
    cron: z.string().min(1, "Cron 不能为空"),
    timezone: z.string().optional().default(""),
    timeoutSeconds: z.coerce.number().min(1, "超时必须大于 0").max(3600, "超时不能超过 3600 秒"),
    description: z.string().optional().default(""),
    url: z.string().optional().default(""),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().default("POST"),
    headers: z.string().optional().default(""),
    body: z.string().optional().default(""),
    agentId: z.string().optional().default(""),
    prompt: z.string().optional().default(""),
  })
  .superRefine((data, ctx) => {
    if (data.type === "http") {
      if (!data.url.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "请输入 URL",
        });
      }
      if (data.headers.trim()) {
        try {
          JSON.parse(data.headers);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["headers"],
            message: "Headers 不是有效的 JSON 格式",
          });
        }
      }
    }
    if (data.type === "agent") {
      if (!data.agentId.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agentId"],
          message: "请选择 Agent",
        });
      }
      if (!data.prompt.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prompt"],
          message: "Prompt 不能为空",
        });
      }
    }
  });

describe("task form schema - common fields", () => {
  test("空名称失败", () => {
    const r = formSchema.safeParse({
      type: "http",
      name: "",
      cron: "0 * * * *",
      timeoutSeconds: 30,
      url: "https://example.com",
    });
    expect(r.success).toBe(false);
  });

  test("空 cron 失败", () => {
    const r = formSchema.safeParse({
      type: "http",
      name: "test",
      cron: "",
      timeoutSeconds: 30,
      url: "https://example.com",
    });
    expect(r.success).toBe(false);
  });

  test("超时小于 1 失败", () => {
    const r = formSchema.safeParse({
      type: "http",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: 0,
      url: "https://example.com",
    });
    expect(r.success).toBe(false);
  });

  test("超时大于 3600 失败", () => {
    const r = formSchema.safeParse({
      type: "http",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: 3601,
      url: "https://example.com",
    });
    expect(r.success).toBe(false);
  });
});

describe("task form schema - HTTP type", () => {
  test("有效的 HTTP 表单通过", () => {
    const r = formSchema.safeParse({
      type: "http",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: 30,
      url: "https://example.com",
      method: "POST",
      headers: '{"Content-Type":"application/json"}',
      body: '{"key":"value"}',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.type).toBe("http");
      expect(r.data.url).toBe("https://example.com");
    }
  });

  test("HTTP 类型空 URL 失败", () => {
    const r = formSchema.safeParse({
      type: "http",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: 30,
      url: "",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const urlIssue = r.error.issues.find((i) => i.path[0] === "url");
      expect(urlIssue).toBeDefined();
    }
  });

  test("HTTP headers 非法 JSON 失败", () => {
    const r = formSchema.safeParse({
      type: "http",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: 30,
      url: "https://example.com",
      headers: "not-json",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const headersIssue = r.error.issues.find((i) => i.path[0] === "headers");
      expect(headersIssue).toBeDefined();
    }
  });

  test("HTTP 空 headers 和 body 通过", () => {
    const r = formSchema.safeParse({
      type: "http",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: 30,
      url: "https://example.com",
      headers: "",
      body: "",
    });
    expect(r.success).toBe(true);
  });

  test("HTTP 默认 method 为 POST", () => {
    const r = formSchema.safeParse({
      type: "http",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: 30,
      url: "https://example.com",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.method).toBe("POST");
  });
});

describe("task form schema - Agent type", () => {
  test("有效的 Agent 表单通过", () => {
    const r = formSchema.safeParse({
      type: "agent",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: 300,
      agentId: "agent-uuid",
      prompt: "帮我做一份报告",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.type).toBe("agent");
      expect(r.data.agentId).toBe("agent-uuid");
    }
  });

  test("Agent 类型空 agentId 失败", () => {
    const r = formSchema.safeParse({
      type: "agent",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: 300,
      agentId: "",
      prompt: "prompt",
    });
    expect(r.success).toBe(false);
  });

  test("Agent 类型空 prompt 失败", () => {
    const r = formSchema.safeParse({
      type: "agent",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: 300,
      agentId: "agent-uuid",
      prompt: "",
    });
    expect(r.success).toBe(false);
  });

  test("Agent 类型不校验 url", () => {
    const r = formSchema.safeParse({
      type: "agent",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: 300,
      agentId: "agent-uuid",
      prompt: "prompt",
      url: "",
    });
    expect(r.success).toBe(true);
  });
});

describe("task form schema - coerce timeoutSeconds", () => {
  test("timeoutSeconds 字符串被转为数字", () => {
    const r = formSchema.safeParse({
      type: "http",
      name: "test",
      cron: "0 * * * *",
      timeoutSeconds: "60",
      url: "https://example.com",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(typeof r.data.timeoutSeconds).toBe("number");
      expect(r.data.timeoutSeconds).toBe(60);
    }
  });
});
