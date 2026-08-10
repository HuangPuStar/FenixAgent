/**
 * agent-expert-sync.ts — 内置专家（system 行）与 `.agents/agents/*.md` 模板文件的双向同步编排。
 *
 * 决策 D2/D3：仅启动时幂等同步 + `refresh` action 手动触发，不做热监听。
 * 四态规则：
 *   文件存在且行不存在      → insert（builtin=true, organizationId="system", enabled）
 *   文件存在且行存在        → upsert 内容 + disabled 置回 false（幂等）
 *   文件不存在且行 enabled  → 标记 disabled（软删除，不物理删除，决策 D3）
 *   文件不存在且行 disabled → 不动
 *
 * 失败仅告警不影响服务启动（与 syncBuiltin 现有 try/catch 语义一致）；
 * 多实例并发启动由 repository 的 onConflictDoUpdate 幂等兜底。
 */
import { error as logError } from "@fenix/logger";
import { listAllBuiltinExperts, setExpertDisabled, upsertExpertByOrgName } from "../repositories/agent-expert";
import type { AgentTemplate } from "./agent-templates";
import { loadAgentTemplates } from "./agent-templates";

export const SYSTEM_ORGANIZATION_ID = "system";

/** frontmatter.name 非法（含路径分隔符/相对路径逃逸）时回退到文件 id，防渲染路径穿越 */
export function sanitizeExpertName(name: string): string | null {
  if (name.length === 0 || name.length > 64) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  // 与 isValidResourceName 对齐：Unicode 字母/数字/空格/单连字符
  return /^[\p{L}0-9][\p{L}0-9 -]*[\p{L}0-9]$|^[\p{L}0-9]$/u.test(name) ? name : null;
}

interface AgentExpertSyncDeps {
  loadTemplates?: () => AgentTemplate[];
  listBuiltin?: () => Promise<Awaited<ReturnType<typeof listAllBuiltinExperts>>>;
  upsert?: typeof upsertExpertByOrgName;
  setDisabled?: typeof setExpertDisabled;
  logError?: typeof logError;
}

/**
 * 执行内置专家同步（幂等）。逐文件容错：单个模板失败仅告警，不影响其余同步；
 * 整体失败由调用方（syncBuiltin）的 try/catch 兜底。
 */
export async function syncBuiltinExperts(deps: AgentExpertSyncDeps = {}): Promise<void> {
  const loadTemplates = deps.loadTemplates ?? loadAgentTemplates;
  const listBuiltin = deps.listBuiltin ?? listAllBuiltinExperts;
  const upsert = deps.upsert ?? upsertExpertByOrgName;
  const setDisabled = deps.setDisabled ?? setExpertDisabled;
  const logFail = deps.logError ?? logError;

  let templates: AgentTemplate[];
  try {
    templates = loadTemplates();
  } catch (err) {
    // 模板目录不可读不阻塞启动：专家库保持现状（可能是部署目录裁剪）
    logFail("[agent-expert-sync] failed to load agent templates, skipping builtin expert sync", err);
    return;
  }

  // 文件 id → 模板（文件重名时按字典序后者覆盖，与 loadAgentTemplates 语义一致）；
  // 行内 name 与文件存在性判断都用 sanitize 后的 name（frontmatter.name ?? 文件 id）
  const templatesByName = new Map<string, { template: AgentTemplate; safeName: string }>();
  for (const template of templates) {
    const rawName = template.name;
    const safeName = sanitizeExpertName(rawName) ?? template.id;
    if (safeName !== rawName) {
      // frontmatter.name 非法（含路径分隔符/相对路径逃逸）时回退到文件 id，
      // 保证渲染文件名不路径穿越；记录告警保留诊断上下文
      logFail(
        `[agent-expert-sync] template '${template.id}' has invalid frontmatter name '${rawName}', falling back to file id`,
        undefined,
      );
    }
    templatesByName.set(template.id, { template, safeName });
  }

  let builtinRows: Awaited<ReturnType<typeof listAllBuiltinExperts>> = [];
  try {
    builtinRows = await listBuiltin();
  } catch (err) {
    logFail("[agent-expert-sync] failed to list builtin experts", err);
    return;
  }

  for (const { template, safeName } of templatesByName.values()) {
    try {
      await upsert(SYSTEM_ORGANIZATION_ID, {
        name: safeName,
        description: template.description || null,
        prompt: template.prompt,
        skills: template.skills,
        model: template.model ?? null,
        mode: template.mode ?? "subagent",
        temperature: template.temperature ?? null,
        steps: template.steps ?? null,
        permission: template.permission ?? null,
        builtin: true,
        disabled: false,
        userId: null,
      });
    } catch (err) {
      logFail(`[agent-expert-sync] failed to upsert builtin expert '${safeName}'`, err);
    }
  }

  // 文件不存在且行 enabled → 软删除；disabled 不动（四态规则）。
  // 存在性按行内 name 判断（行内 name 即 sanitize 后的 frontmatter.name ?? 文件 id）
  const presentNames = new Set([...templatesByName.values()].map(({ safeName }) => safeName));
  for (const row of builtinRows) {
    if (presentNames.has(row.name) || row.disabled) continue;
    try {
      await setDisabled(row.id, true);
    } catch (err) {
      logFail(`[agent-expert-sync] failed to disable builtin expert '${row.name}'`, err);
    }
  }
}
