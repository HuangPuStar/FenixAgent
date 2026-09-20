import type { ResourceAccessActions, ResourceScopeView } from "@fenix/web-runtime/types/config";

/**
 * 前端授权判断的最小输入形状。
 *
 * 字段全部可选：这些 helper 既接收 `/web` 列表视图（含 `scope`/`access`），也接收对话框等局部对象。
 * 判断依据是服务端返回的归属 `scope` 与有效动作 `access.actions`，缺失时必须按「本组织私有、不可读不可写」
 * 保守降级，不得假设可写。
 */
export interface SkillResourceLike {
  id?: string;
  name: string;
  scope?: ResourceScopeView;
  access?: { actions?: ResourceAccessActions };
  organizationName?: string;
}

export interface SkillOptionLike extends SkillResourceLike {
  description?: string;
}

export interface SkillOptionView {
  id: string;
  key: string;
  name: string;
  label: string;
  description: string;
  scope?: ResourceScopeView;
  organizationName?: string;
}

/**
 * 资源的跨组织稳定键。
 *
 * 新授权视图不再提供 `resourceAccess.resourceKey`，因此按 `${scope.organizationId}/${id}` 自行推导：
 * 二者缺一都无法保证跨组织唯一，此时退回 `name`（资源名在同一组织内唯一）。
 */
export function getSkillKey(skill: SkillResourceLike) {
  const organizationId = skill.scope?.organizationId;
  if (organizationId && skill.id) return `${organizationId}/${skill.id}`;
  return skill.name;
}

/**
 * 详情读取使用的查找键，语义与 {@link getSkillKey} 相同。
 *
 * 独立命名是为了标明调用点意图：`/web/config/skills/:name` 的 `name` 参数同时承载技能名与跨组织资源键。
 */
export function getSkillLookupKey(skill: SkillResourceLike) {
  return getSkillKey(skill);
}

/**
 * 判断资源是否归属其他组织。
 *
 * 两种情况按本组织资源处理，与后端「缺失 `scope` 视为 internal」的语义一致：
 * 资源本身无归属组织（个人资源）；当前组织 id 未知（组织上下文未就绪）。后者若按外部处理，
 * 会在加载瞬间把用户自己的资源标成共享来源并从「本组织」筛选中隐藏。
 */
export function isExternalSkill(skill: SkillResourceLike, activeOrganizationId?: string) {
  const organizationId = skill.scope?.organizationId;
  if (!organizationId || !activeOrganizationId) return false;
  return organizationId !== activeOrganizationId;
}

/** 是否可写；`update` 动作缺失时保守视为不可写。 */
export function canWriteSkill(skill: SkillResourceLike) {
  return skill.access?.actions?.includes("update") ?? false;
}

/** 是否可管理公开状态；与写权限等价，均由 `update` 动作决定。 */
export function canManageSkillSharing(skill: SkillResourceLike) {
  return canWriteSkill(skill);
}

/** 是否已对其他组织公开；决定展示角标与公开开关的文案。 */
export function isPublicSkill(skill: SkillResourceLike) {
  return skill.scope?.visibility === "public";
}

/** 资源角标 i18n key：外部组织资源优先，其次公开，否则本组织私有。 */
export function getSkillResourceBadgeKey(skill: SkillResourceLike, activeOrganizationId?: string) {
  if (isExternalSkill(skill, activeOrganizationId)) return "resource.external";
  if (isPublicSkill(skill)) return "resource.public";
  return "resource.internal";
}

/** Agent 表单选项值：资源 id 全局唯一，缺失时退回资源名。 */
export function getSkillOptionValue(skill: SkillOptionLike) {
  return skill.id ?? skill.name;
}

/** 展示名：跨组织资源补上归属组织名以便区分同名资源，否则直接用资源名。 */
export function getSkillOptionLabel(skill: SkillOptionLike) {
  const organizationName = skill.organizationName;
  if (organizationName) return `${organizationName}/${skill.name}`;
  return skill.name;
}

/**
 * 将 skill 列表映射为 Agent 表单可直接消费的展示结构。
 *
 * 授权视图字段（`scope` / `organizationName`）原样透传，供调用方按归属分组；本函数不自行判断组织。
 */
export function mapSkillOptions(skills: SkillOptionLike[]): SkillOptionView[] {
  return skills.map((skill) => ({
    id: getSkillOptionValue(skill),
    key: getSkillKey(skill),
    name: skill.name,
    label: getSkillOptionLabel(skill),
    description: skill.description ?? "",
    scope: skill.scope,
    organizationName: skill.organizationName,
  }));
}

/**
 * 兼容 SkillConfigApi 的数组返回，以及历史对象包裹结构。
 */
export function normalizeSkillOptionsPayload(payload: unknown): SkillOptionView[] {
  if (Array.isArray(payload)) {
    return mapSkillOptions(payload as SkillOptionLike[]);
  }
  if (payload && typeof payload === "object" && Array.isArray((payload as { skills?: unknown }).skills)) {
    return mapSkillOptions((payload as { skills: SkillOptionLike[] }).skills);
  }
  return [];
}
