// 专家库内置同步（syncBuiltinExperts）四态规则测试（设计 §7：内置同步幂等，
// 含文件删除 → disabled、恢复 → enabled）。依赖注入 fake，不触达 DB。
import { describe, expect, test } from "bun:test";
import type { AgentExpertInsert, AgentExpertRow } from "../repositories/agent-expert";
import { sanitizeExpertName, syncBuiltinExperts } from "../services/agent-expert-sync";
import type { AgentTemplate } from "../services/agent-templates";

function makeTemplate(overrides: Partial<AgentTemplate> & { id: string }): AgentTemplate {
  const { id, ...rest } = overrides;
  return { id, name: rest.name ?? id, description: "", prompt: "body", skills: [], ...rest };
}

function makeBuiltinRow(overrides: Partial<AgentExpertRow> & { id: string; name: string }): AgentExpertRow {
  const { id, name, ...rest } = overrides;
  return {
    id,
    organizationId: "system",
    userId: null,
    name,
    description: null,
    prompt: "body",
    skills: [],
    model: null,
    mode: "subagent",
    temperature: null,
    steps: null,
    permission: null,
    builtin: true,
    disabled: false,
    extra: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...rest,
  };
}

interface SyncCallLog {
  upserted: Array<{ name: string; disabled: boolean }>;
  disabled: string[];
}

function runSync(templates: AgentTemplate[], rows: AgentExpertRow[]) {
  const log: SyncCallLog = { upserted: [], disabled: [] };
  const deps = {
    loadTemplates: () => templates,
    listBuiltin: async () => rows,
    upsert: async (_org: string, input: Omit<AgentExpertInsert, "organizationId"> & { name: string }) => {
      log.upserted.push({ name: input.name, disabled: input.disabled ?? false });
      return null as unknown as AgentExpertRow;
    },
    setDisabled: async (id: string, disabled: boolean) => {
      log.disabled.push(`${id}:${disabled}`);
      return true;
    },
    logError: () => {},
  };
  return { run: () => syncBuiltinExperts(deps), log };
}

describe("syncBuiltinExperts 四态规则（决策 D2/D3）", () => {
  // 文件存在且行不存在 → insert（upsert builtin=true、disabled=false）
  test("文件存在且行不存在时执行 upsert 且 enabled", async () => {
    const { run, log } = runSync([makeTemplate({ id: "expert-a" })], []);
    await run();
    expect(log.upserted).toEqual([{ name: "expert-a", disabled: false }]);
    expect(log.disabled).toEqual([]);
  });

  // 文件存在且行存在 → upsert 内容 + disabled 置回 false（恢复路径）
  test("文件存在且行 disabled 时恢复 enabled", async () => {
    const row = makeBuiltinRow({ id: "r1", name: "expert-a", disabled: true });
    const { run, log } = runSync([makeTemplate({ id: "expert-a" })], [row]);
    await run();
    expect(log.upserted).toEqual([{ name: "expert-a", disabled: false }]);
    expect(log.disabled).toEqual([]);
  });

  // 文件不存在且行 enabled → 标记 disabled（软删除，不物理删除）
  test("文件不存在且行 enabled 时软删除", async () => {
    const row = makeBuiltinRow({ id: "r1", name: "expert-a", disabled: false });
    const { run, log } = runSync([], [row]);
    await run();
    expect(log.disabled).toEqual(["r1:true"]);
    expect(log.upserted).toEqual([]);
  });

  // 文件不存在且行 disabled → 不动
  test("文件不存在且行 disabled 时不动", async () => {
    const row = makeBuiltinRow({ id: "r1", name: "expert-a", disabled: true });
    const { run, log } = runSync([], [row]);
    await run();
    expect(log.disabled).toEqual([]);
    expect(log.upserted).toEqual([]);
  });

  // 同步幂等：连续两次同步结果一致（第二次无新增 upsert/disabled 之外的动作）
  test("同步幂等：重复执行不产生额外状态变化", async () => {
    const row = makeBuiltinRow({ id: "r1", name: "expert-a", disabled: false });
    const { run, log } = runSync([makeTemplate({ id: "expert-a" })], [row]);
    await run();
    await run();
    // 两次都 upsert（内容刷新），但从不触发 disabled
    expect(log.upserted.filter((u) => u.disabled)).toEqual([]);
    expect(log.disabled).toEqual([]);
  });

  // frontmatter.name 含路径分隔符时回退文件 id（防渲染路径穿越）
  test("非法 frontmatter.name 回退文件 id", async () => {
    const { run, log } = runSync([makeTemplate({ id: "safe-id", name: "../evil" })], []);
    await run();
    expect(log.upserted.map((u) => u.name)).toEqual(["safe-id"]);
  });
});

describe("sanitizeExpertName 名称校验", () => {
  // 合法名称（Unicode 字母/数字/空格/单连字符，1-64 字符）
  test("合法名称通过", () => {
    expect(sanitizeExpertName("Code Reviewer")).toBe("Code Reviewer");
    expect(sanitizeExpertName("中文专家-1")).toBe("中文专家-1");
  });

  // 路径穿越与非法字符必须拒绝
  test("路径分隔符与相对路径逃逸被拒绝", () => {
    expect(sanitizeExpertName("a/b")).toBeNull();
    expect(sanitizeExpertName("..")).toBeNull();
    expect(sanitizeExpertName("a\\b")).toBeNull();
    expect(sanitizeExpertName("")).toBeNull();
    expect(sanitizeExpertName("a".repeat(65))).toBeNull();
  });
});
