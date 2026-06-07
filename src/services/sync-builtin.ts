import type { AuthContext } from "../plugins/auth";
import { syncBuiltinSkillsToSystemAdmin } from "./meta-agent";
import { ensureSystemAdmin } from "./system-admin";

type BuiltinSyncContext = AuthContext;

/** 将系统 admin 引导结果收口成统一的 builtin 同步上下文。 */
async function resolveSystemBuiltinContext(
  deps: { ensureSystemAdmin?: typeof ensureSystemAdmin } = {},
): Promise<BuiltinSyncContext> {
  const ensureSystemAdminFn = deps.ensureSystemAdmin ?? ensureSystemAdmin;
  const admin = await ensureSystemAdminFn();
  return {
    organizationId: admin.organization.id,
    userId: admin.userId,
    role: "owner",
  };
}

/** 当前 builtin 范围只有 skill；后续新增 provider/template 时按同样模式继续扩展。 */
async function syncBuiltinSkills(
  ctx: BuiltinSyncContext,
  deps: { syncBuiltinSkillsToSystemAdmin?: (ctx: AuthContext) => Promise<void> } = {},
): Promise<void> {
  const syncBuiltinSkillsToSystemAdminFn = deps.syncBuiltinSkillsToSystemAdmin ?? syncBuiltinSkillsToSystemAdmin;
  await syncBuiltinSkillsToSystemAdminFn(ctx);
}

/**
 * 启动期统一 builtin 编排入口。
 *
 * 这个文件故意不放在 `meta-agent.ts` 中，因为后续 builtin 资源可能不止 skill。
 * 当前它只负责串起“系统 admin 就绪”与“builtin skill 托管到系统组织”两步，
 * 后续如果新增 builtin provider / template，也应该在这里继续扩展。
 */
export async function syncBuiltin(
  deps: {
    ensureSystemAdmin?: typeof ensureSystemAdmin;
    syncBuiltinSkillsToSystemAdmin?: (ctx: AuthContext) => Promise<void>;
  } = {},
): Promise<void> {
  const ctx = await resolveSystemBuiltinContext({ ensureSystemAdmin: deps.ensureSystemAdmin });
  await syncBuiltinSkills(ctx, {
    syncBuiltinSkillsToSystemAdmin: deps.syncBuiltinSkillsToSystemAdmin,
  });
}
