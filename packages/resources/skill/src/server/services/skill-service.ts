import type { ResourceQueryConstraint, ResourceVisibility } from "@fenix/platform-sdk";
import type { SQL } from "drizzle-orm";
import type { ScopedSkillRow, SkillRepository, SkillRow, SkillWriteData } from "../repositories/skill";

/**
 * Skill 资源行的领域服务。
 *
 * 只承载领域规则（资源键解析、受控读取的编排）与持久化编排；不接收 actor、不做任何权限判断——
 * 授权在 Facade 完成，受控读取把不透明的 `access` 条件原样交给仓储下推。
 *
 * 文件系统内容（SKILL.md、归档）不在这里：见 `skill-content.ts`。两个模块的边界就是"资源行"与
 * "文档内容"，因此在同一次 setSkill 里它们是两次独立写入，回滚顺序由 Facade 决定。
 *
 * 这里的每个方法都假定调用方已完成授权：Facade 是用户请求路径的唯一合法调用方；系统路径
 * （builtin 同步、launch spec 读取）单独命名并单独注释，避免与受控路径混用。
 */

/** 资源键：`<organizationId>/<resourceId>`，跨组织可见资源的稳定定位方式。 */
export interface ParsedSkillResourceKey {
  readonly organizationId: string;
  readonly resourceId: string;
}

/** 解析资源键；格式不合法返回 null（不是异常：路由把它当作"找不到该名称的资源"）。 */
export function parseSkillResourceKey(resourceKey: string): ParsedSkillResourceKey | null {
  const slashIndex = resourceKey.indexOf("/");
  if (slashIndex <= 0 || slashIndex === resourceKey.length - 1) return null;
  return {
    organizationId: resourceKey.slice(0, slashIndex),
    resourceId: resourceKey.slice(slashIndex + 1),
  };
}

/** 受控读取的公共输入：`access` 必须是 Facade 产出的不透明条件。 */
export interface SkillReadInput {
  readonly access: ResourceQueryConstraint;
  /** 业务排序（下推到 ORDER BY）；由调用方从仓库导出的 `SKILL_LIST_ORDER` 选取。 */
  readonly order?: readonly SQL[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface SkillService {
  list(input: SkillReadInput): Promise<{ items: readonly ScopedSkillRow[]; total: number }>;
  findById(input: { access: ResourceQueryConstraint; resourceId: string }): Promise<ScopedSkillRow | undefined>;
  findByName(input: {
    access: ResourceQueryConstraint;
    name: string;
    organizationId?: string;
  }): Promise<ScopedSkillRow | undefined>;
  /** 按名称批量读取（导入冲突检测与回读）；一次查询取回全部命中行。 */
  listByNames(input: {
    access: ResourceQueryConstraint;
    names: readonly string[];
    organizationId: string;
  }): Promise<readonly ScopedSkillRow[]>;
  findByResourceKey(input: {
    access: ResourceQueryConstraint;
    resourceKey: string;
  }): Promise<ScopedSkillRow | undefined>;
  /** 受控创建；名称冲突（同组织同名）返回 undefined，由 Facade 映射为 409。 */
  create(input: {
    name: string;
    data: SkillWriteData;
    organizationId: string;
    ownerUserId: string;
    visibility: string;
  }): Promise<string | undefined>;
  /**
   * 幂等写入（system / builtin 路径）。
   *
   * 同步流程按 (组织, 名称) 收敛，重复执行只更新文档元数据；它与 `create` 的区别是**不**要求
   * 资源不存在，也不改变归属列与 `visibility`。
   */
  upsertByOrgAndName(input: {
    name: string;
    data: SkillWriteData;
    organizationId: string;
    ownerUserId: string;
  }): Promise<string | undefined>;
  update(input: { resourceId: string; data: SkillWriteData }): Promise<boolean>;
  remove(input: { resourceId: string }): Promise<boolean>;
  /** 按 (组织, 名称) 删除；导入回滚用它（回滚阶段只有名称）。 */
  removeByName(input: { organizationId: string; name: string }): Promise<boolean>;
  /**
   * 无授权读取单行；仅供已完成权限校验的系统路径使用（builtin 同步、launch spec 构建）。
   *
   * 单独命名而不是复用受控入口：调用点必须显式写出 `Unscoped` 字样，代码评审时一眼可见这是
   * 绕过授权的路径，不会与「Facade 已授权后调用的领域方法」混在一起。
   */
  findRowUnscoped(resourceId: string): Promise<SkillRow | undefined>;
  /** 无授权按组织列出（builtin 孤儿清理）。 */
  listByOrganizationUnscoped(organizationId: string): Promise<readonly SkillRow[]>;
  /** 无授权按 (组织, 名称) 读取（builtin 同步）。 */
  findByNameUnscoped(input: { organizationId: string; name: string }): Promise<SkillRow | undefined>;
  /** 无授权更新公开受众（系统托管路径）；取值收敛为 {@link ResourceVisibility}，不接受任意字符串。 */
  setVisibilityUnscoped(input: { resourceId: string; visibility: ResourceVisibility }): Promise<boolean>;
}

export function createSkillService(repository: SkillRepository): SkillService {
  return {
    async list(input) {
      const page = await repository.listReadable({
        access: input.access,
        ...(input.order === undefined ? {} : { order: input.order }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
      });
      return { items: page.items, total: page.total ?? page.items.length };
    },

    async findById(input) {
      return repository.findReadableById({ resourceId: input.resourceId, access: input.access });
    },

    async findByName(input) {
      return repository.findReadableByName({
        name: input.name,
        access: input.access,
        ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
      });
    },

    async listByNames(input) {
      return repository.listReadableByNames({
        names: input.names,
        access: input.access,
        organizationId: input.organizationId,
      });
    },

    async findByResourceKey(input) {
      const parsed = parseSkillResourceKey(input.resourceKey);
      if (!parsed) return;
      // 键里的组织必须与行的归属组织一致：否则 `orgA/<orgB 的资源 id>` 会读到别人的资源。
      return repository.findReadableByKey({
        organizationId: parsed.organizationId,
        resourceId: parsed.resourceId,
        access: input.access,
      });
    },

    async create(input) {
      return repository.insert(input);
    },

    async upsertByOrgAndName(input) {
      return repository.upsertByOrgAndName(input);
    },

    async update(input) {
      return repository.updateById({ resourceId: input.resourceId, data: input.data });
    },

    async remove(input) {
      return repository.deleteById({ resourceId: input.resourceId });
    },

    async removeByName(input) {
      return repository.deleteByOrgAndName({ organizationId: input.organizationId, name: input.name });
    },

    async findRowUnscoped(resourceId) {
      // 无授权读取：调用方必须已自行完成权限校验（builtin 同步、launch spec 构建等系统路径）。
      return repository.findByIdUnscoped({ resourceId });
    },

    async listByOrganizationUnscoped(organizationId) {
      return repository.listByOrganizationUnscoped({ organizationId });
    },

    async findByNameUnscoped(input) {
      return repository.findByNameUnscoped(input);
    },

    async setVisibilityUnscoped(input) {
      return repository.updateVisibilityUnscoped(input);
    },
  };
}
