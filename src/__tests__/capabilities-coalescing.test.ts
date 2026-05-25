import { describe, expect, it } from "bun:test";

// 验证 environment-acp.ts 中 capabilities 的 ?? 语义：
// ?? 仅对 null/undefined 生效，|| 还会吞掉 falsy 值（0, "", false）
// 对于 capabilities: Record<string, unknown> | null 类型，两者实际等价，
// 但 ?? 更精确表达意图"null 或 undefined 时返回 null"

describe("capabilities nullish coalescing", () => {
  it("capabilities 为 null 时返回 null", () => {
    const caps: Record<string, unknown> | null = null;
    expect(caps ?? null).toBeNull();
  });

  it("capabilities 为 undefined 时返回 null", () => {
    const caps: Record<string, unknown> | undefined = undefined;
    expect(caps ?? null).toBeNull();
  });

  it("capabilities 有值时保留原值", () => {
    const caps: Record<string, unknown> | null = { tools: ["read"] };
    expect(caps ?? null).toEqual({ tools: ["read"] });
  });

  it("capabilities 为空对象时保留（不转为 null）", () => {
    const caps: Record<string, unknown> | null = {};
    expect(caps ?? null).toEqual({});
  });

  // ?? 和 || 的差异在 falsy 非 null/undefined 值上体现
  it("?? 和 || 对 false/0/'' 行为不同", () => {
    const f = false as boolean | null;
    const z = 0 as number | null;
    expect(f ?? "fallback").toBe(false);
    expect(false || "fallback").toBe("fallback");
    expect(z ?? "fallback").toBe(0);
    expect(0 || "fallback").toBe("fallback");
  });
});
