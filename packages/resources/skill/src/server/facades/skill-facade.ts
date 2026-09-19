import { createLogger } from "@fenix/logger";
import {
  type ActorContext,
  AuthorizedResourceFacade,
  type AuthorizedResourceFacadeOptions,
  type ResourceAccess,
  ResourceAccessDeniedError,
  type ResourceAction,
  type ResourceScope,
} from "@fenix/platform-sdk";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@server/errors";
import type { ScopedSkillRow, SkillWriteData } from "../repositories/skill";
import { SKILL_LIST_ORDER, toSkillMetadata } from "../repositories/skill";
import type { ImportConflictStrategy, ImportSkillsConflict, UploadSkillFile } from "../services/skill-content";
import {
  deleteSkillDocument,
  groupUploadFilesForImport,
  importSkillDirectories,
  normalizeSkillWriteData,
  readSkillDetail,
  skillContentPath,
  stripNameAndDescription,
  validateSkillName,
  writeSkillDocument,
} from "../services/skill-content";
import type { SkillService } from "../services/skill-service";

/**
 * Skill 的资源应用 Facade：授权编排 + 内容与资源行的补偿写入。
 *
 * 它是 Skill 资源的唯一应用入口（`route → Facade → Domain Service → Repository`）：route 只做协议
 * 接入与响应映射，领域服务不认识 actor。所有授权判断都经 `AccessControlModule`（继承基类的
 * `resolveInitialScope` / `listConstraint` / `authorizeAction` / `withAccess*` / `setVisibility`），
 * 本文件不复制任何组织、角色或 `visibility` 规则。
 *
 * Skill 的内容（SKILL.md 与归档）在文件系统、元数据在 `skill` 表，两者是不同介质，因此每个写路径
 * 都必须给出补偿顺序：见 {@link SkillFacade.create} / {@link SkillFacade.update} 的说明。
 *
 * 平台抛出的 {@link ResourceAccessDeniedError} 在这里映射为对外 403；其余错误原样上抛，避免把存储
 * 或装配故障伪装成权限问题。
 */

const log = createLogger("skill");

/** 列表项：资源行投影 + 归属范围 + 当前主体有效动作 + 内容路径。 */
export interface SkillListItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** SKILL.md 的绝对路径（展示字段，与授权无关）。 */
  readonly path: string;
  readonly scope: ResourceScope;
  readonly access: ResourceAccess;
}

/** 详情：列表项 + SKILL.md 正文与元数据。 */
export interface SkillDetailView extends SkillListItem {
  readonly content: string;
  readonly metadata: Record<string, string>;
}

/** 写入内容；创建与更新共用同一形状（与迁移前的 `setSkill` 数据参数一致）。 */
export interface SkillWriteInput {
  readonly description: string;
  readonly content: string;
  readonly metadata?: Record<string, string>;
}

/** 创建输入；`publicReadable` 在创建期即写入 `visibility`（成员无权创建，因此没有放权风险）。 */
export interface SkillCreateInput {
  readonly name: string;
  readonly data: SkillWriteInput;
  readonly publicReadable?: boolean;
}

/** 更新输入；`publicReadable` 不传表示"只改内容，不动公开受众"。 */
export interface SkillUpdateOptions {
  readonly publicReadable?: boolean;
}

/** 导入结果；`imported` 是回读后的资源视图，与列表/详情的形状一致。 */
export interface SkillImportResult {
  readonly imported: readonly SkillListItem[];
  readonly skipped: readonly string[];
  readonly conflicts: readonly ImportSkillsConflict[];
}

/**
 * Skill 资源的应用接口（Facade 的契约面）。
 *
 * 路由与其它调用方只依赖本接口，不依赖 `SkillFacade` 的继承结构或私有依赖；测试可以提供实现而不
 * 构造真类（见 `@fenix/resource-skill/server/testing`）。
 *
 * 名称 / 资源键与资源 ID 两组入口并存是协议需要：`/web` 用名称或资源键定位（用户看到的是名称），
 * 已发布的 `/api/skills/:id` 用资源 ID 定位；两者的授权与可见性判定完全一致。
 */
export interface SkillFacadeApi {
  list(
    actor: ActorContext,
    options?: { limit?: number; offset?: number },
  ): Promise<{ items: SkillListItem[]; total: number }>;
  get(actor: ActorContext, nameOrKey: string): Promise<SkillListItem | undefined>;
  getById(actor: ActorContext, resourceId: string): Promise<SkillListItem | undefined>;
  readDetail(actor: ActorContext, nameOrKey: string): Promise<SkillDetailView | undefined>;
  readDetailById(actor: ActorContext, resourceId: string): Promise<SkillDetailView | undefined>;
  create(actor: ActorContext, input: SkillCreateInput): Promise<SkillListItem>;
  update(
    actor: ActorContext,
    nameOrKey: string,
    data: SkillWriteInput,
    options?: SkillUpdateOptions,
  ): Promise<SkillListItem>;
  /** 仅更新公开受众，不读取、不解析、不改写 SKILL.md。 */
  setPublicReadable(actor: ActorContext, nameOrKey: string, publicReadable: boolean): Promise<SkillListItem>;
  remove(actor: ActorContext, nameOrKey: string): Promise<void>;
  removeById(actor: ActorContext, resourceId: string): Promise<void>;
  importDirectories(
    actor: ActorContext,
    files: UploadSkillFile[],
    strategy?: ImportConflictStrategy,
  ): Promise<SkillImportResult>;
}

export class SkillFacade extends AuthorizedResourceFacade implements SkillFacadeApi {
  constructor(
    private readonly service: SkillService,
    options: AuthorizedResourceFacadeOptions,
  ) {
    super(options);
  }

  /**
   * 列表：授权谓词、排序与分页都下推到 SQL（决策 D9：`/web` 不传分页参数，`/api` 传 limit/offset）。
   *
   * 排序取 `SKILL_LIST_ORDER`（创建时间倒序）而不是前端传来的顺序：跨组织合并后的列表必须由数据库
   * 给出确定次序。`total` 与 `items` 共用同一份授权谓词与业务条件，翻页不会翻出可见集合之外。
   */
  async list(
    actor: ActorContext,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ items: SkillListItem[]; total: number }> {
    const access = await this.listConstraint(actor, "read");
    const { items, total } = await this.service.list({
      access,
      order: SKILL_LIST_ORDER,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.offset === undefined ? {} : { offset: options.offset }),
    });
    const authorized = await this.withAccessMany(actor, items);
    return { items: authorized.map((row) => this.toListItem(row)), total };
  }

  /** 详情/读取：名称或跨组织资源键（`<organizationId>/<resourceId>`）。 */
  async get(actor: ActorContext, nameOrKey: string): Promise<SkillListItem | undefined> {
    const row = await this.findVisible(actor, nameOrKey);
    return row ? this.toListItem(await this.withAccess(actor, row)) : undefined;
  }

  /** 详情/读取：按资源 ID（对外 `/api/skills/:id`）。 */
  async getById(actor: ActorContext, resourceId: string): Promise<SkillListItem | undefined> {
    const row = await this.findVisibleById(actor, resourceId);
    return row ? this.toListItem(await this.withAccess(actor, row)) : undefined;
  }

  /**
   * 读取详情（含 SKILL.md 正文）。
   *
   * 内容缺失（文件被外部删除）时正文为空串、元数据取空表：描述回落到资源行的列，仍返回可读条目，
   * 与迁移前"内容读不到不阻塞详情"的行为一致。
   */
  async readDetail(actor: ActorContext, nameOrKey: string): Promise<SkillDetailView | undefined> {
    const row = await this.findVisible(actor, nameOrKey);
    return row ? this.buildDetail(actor, row) : undefined;
  }

  /** 读取详情（含 SKILL.md 正文）：按资源 ID。 */
  async readDetailById(actor: ActorContext, resourceId: string): Promise<SkillDetailView | undefined> {
    const row = await this.findVisibleById(actor, resourceId);
    return row ? this.buildDetail(actor, row) : undefined;
  }

  /**
   * 创建：先写资源行、再写文件内容。
   *
   * 顺序刻意与"先写文件再写行"相反：同组织同名由唯一索引拦下（`insert` 返回空集），若先写文件，
   * 冲突时就已经覆盖了既有资源正在使用的内容；先写行则冲突路径完全不碰文件系统。内容写入失败时
   * 再删除刚建的行作为补偿——行与内容都回到"不存在"，没有中间态。
   *
   * 冲突判定只依赖当前组织内的唯一索引，不做"先查同名再写"：跨组织公开的同名 Skill 不属于本组织，
   * 不应被判成 CONFLICT。
   */
  async create(actor: ActorContext, input: SkillCreateInput): Promise<SkillListItem> {
    const scope = await this.resolveCreateScope(actor);
    const organizationId = scope.organizationId;
    if (organizationId === undefined) {
      throw new Error("Skill 归属组织缺失：组织资源必须落在某个组织上");
    }
    const safeName = validateSkillName(input.name);
    const normalized = normalizeSkillWriteData(input.data);

    const resourceId = await this.service.create({
      name: safeName,
      data: { description: normalized.description, metadata: normalized.metadata },
      organizationId,
      ownerUserId: scope.ownerUserId ?? actor.userId,
      visibility: input.publicReadable === true ? "public" : scope.visibility,
    });
    if (resourceId === undefined) throw new ConflictError(`Skill '${safeName}' already exists`);

    try {
      await writeSkillDocument({
        organizationId,
        name: safeName,
        description: normalized.description,
        content: normalized.content,
        ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
      });
    } catch (error) {
      await this.rollbackCreate(resourceId, safeName, error);
      throw error;
    }

    return this.requireItemById(actor, resourceId, safeName);
  }

  /**
   * 更新：先写文件内容（资源行写入在文件快照的保护范围内），再按需更新公开受众。
   *
   * 资源行写入由 `writeSkillDocument` 的 `persist` 回调执行：行写入失败会先恢复文件内容再上抛，
   * 因此不会留下"行说新描述、文件是旧正文"的错位。
   */
  async update(
    actor: ActorContext,
    nameOrKey: string,
    data: SkillWriteInput,
    options: SkillUpdateOptions = {},
  ): Promise<SkillListItem> {
    const row = await this.requireVisible(actor, nameOrKey);
    await this.requireAction(actor, "update", row.id);
    const normalized = normalizeSkillWriteData(data);

    await writeSkillDocument({
      organizationId: row.organizationId,
      name: row.name,
      description: normalized.description,
      content: normalized.content,
      ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
      persist: async (written) => {
        const updated = await this.service.update({
          resourceId: row.id,
          data: { description: written.description, metadata: written.metadata },
        });
        if (!updated) throw new NotFoundError(`Skill '${row.name}' not found`);
      },
    });

    if (options.publicReadable !== undefined) {
      await this.setVisibility(actor, row.id, options.publicReadable ? "public" : "private");
    }

    return this.requireItemById(actor, row.id, nameOrKey);
  }

  /**
   * 仅更新公开受众：不触碰 SKILL.md。
   *
   * 公开受众是资源授权数据而不是文档内容，走文件写入路径会无谓重写 Skill 文档。
   */
  async setPublicReadable(actor: ActorContext, nameOrKey: string, publicReadable: boolean): Promise<SkillListItem> {
    const row = await this.requireVisible(actor, nameOrKey);
    await this.setVisibility(actor, row.id, publicReadable ? "public" : "private");
    return this.requireItemById(actor, row.id, nameOrKey);
  }

  /**
   * 删除：先删资源行、再清理文件内容。
   *
   * 行删除失败（并发删除、数据库故障）时文件保持原样；内容清理失败只留下不可达文件，不会出现
   * "行还在但内容没了"的可见不一致。
   */
  async remove(actor: ActorContext, nameOrKey: string): Promise<void> {
    const row = await this.requireVisible(actor, nameOrKey);
    await this.requireAction(actor, "delete", row.id);
    await this.deleteRow(row, nameOrKey);
  }

  /** 删除：按资源 ID。 */
  async removeById(actor: ActorContext, resourceId: string): Promise<void> {
    const row = await this.requireVisibleById(actor, resourceId);
    await this.requireAction(actor, "delete", row.id);
    await this.deleteRow(row, resourceId);
  }

  /**
   * 批量导入技能目录。
   *
   * 冲突检测在写入前完成，且**只把当前组织已有的同名资源算作冲突**：其他组织公开的同名 Skill 与
   * 当前组织的自建资源可以共存（同组织同名由唯一索引保证不重复）。若按"任意可读的同名资源"判定，
   * 跨组织同名会被误报为 CONFLICT，用户既无法导入也无法覆盖。
   *
   * 回滚由内容模块驱动：文件写入或资源行写入失败时，新建的恢复为"不存在"，被覆盖的恢复为导入前的
   * 内容与元数据（见 {@link SkillFacade.restoreOverwritten}）。
   */
  async importDirectories(
    actor: ActorContext,
    files: UploadSkillFile[],
    strategy?: ImportConflictStrategy,
  ): Promise<SkillImportResult> {
    try {
      return await this.runImport(actor, files, strategy);
    } catch (error) {
      // 内容层用裸 `code` 表达上传校验失败（清单路径穿越、缺少 SKILL.md、未提供文件）：Facade 的契约
      // 是只抛 AppError 子类，在这里归一，协议层不必认识内容层的错误形状。
      throw toValidationError(error) ?? error;
    }
  }

  /** 导入编排本体；错误形状的归一见 {@link SkillFacade.importDirectories}。 */
  private async runImport(
    actor: ActorContext,
    files: UploadSkillFile[],
    strategy?: ImportConflictStrategy,
  ): Promise<SkillImportResult> {
    const scope = await this.resolveCreateScope(actor);
    const organizationId = scope.organizationId;
    if (organizationId === undefined) {
      throw new Error("Skill 归属组织缺失：组织资源必须落在某个组织上");
    }

    const grouped = groupUploadFilesForImport(files);
    const access = await this.listConstraint(actor, "read");
    const existingRows = await this.service.listByNames({
      access,
      names: [...grouped.keys()],
      organizationId,
    });
    const conflicts: ImportSkillsConflict[] = existingRows.map((row) => ({
      name: row.name,
      enabled: true,
      path: skillContentPath(row.organizationId, row.name),
    }));
    const existingByName = new Map(existingRows.map((row) => [row.name, row] as const));

    const result = await importSkillDirectories({
      organizationId,
      files,
      conflicts,
      ...(strategy === undefined ? {} : { strategy }),
      onSkillWritten: async (info) => {
        // 幂等写入：覆盖导入与"行已存在但内容缺失"的自愈走同一条路径，且不改归属列与 visibility。
        await this.service.upsertByOrgAndName({
          name: info.name,
          data: { description: info.description },
          organizationId,
          ownerUserId: scope.ownerUserId ?? actor.userId,
        });
      },
      onRollbackCleanup: async (rolledBackNames) => {
        for (const name of rolledBackNames) {
          const existing = existingByName.get(name);
          if (existing === undefined) {
            await this.service.removeByName({ organizationId, name });
            continue;
          }
          await this.restoreOverwritten(existing);
        }
      },
    });

    // 回读用同一条授权约束：导入结果与列表在"同一个主体能看到什么"上必须一致。
    const importedRows = await this.service.listByNames({
      access,
      names: result.imported.map((info) => info.name),
      organizationId,
    });
    const authorized = await this.withAccessMany(actor, importedRows);
    return {
      imported: authorized.map((row) => this.toListItem(row)),
      skipped: result.skipped,
      conflicts: result.conflicts,
    };
  }

  /** 行 → 视图：描述取资源行列，路径由归属组织与名称推导（内容只属于归属组织）。 */
  private toListItem(row: ScopedSkillRow & { access: ResourceAccess }): SkillListItem {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      path: skillContentPath(row.organizationId, row.name),
      scope: row.scope,
      access: row.access,
    };
  }

  /** 详情视图：正文与元数据来自 SKILL.md，描述以资源行的列为准、缺失时回落文档头。 */
  private async buildDetail(actor: ActorContext, row: ScopedSkillRow): Promise<SkillDetailView> {
    const authorized = await this.withAccess(actor, row);
    const detail = await readSkillDetail(row.organizationId, row.name);
    return {
      ...this.toListItem(authorized),
      description: row.description ?? detail?.metadata.description ?? "",
      content: detail?.content ?? "",
      metadata: stripNameAndDescription(detail?.metadata ?? {}),
    };
  }

  /** 可见性解析：名称按"当前组织优先"匹配，资源键解析归属组织并校验一致。 */
  private async findVisible(actor: ActorContext, nameOrKey: string): Promise<ScopedSkillRow | undefined> {
    const access = await this.listConstraint(actor, "read");
    if (nameOrKey.includes("/")) {
      return this.service.findByResourceKey({ access, resourceKey: nameOrKey });
    }
    const activeOrganizationId = actor.activeOrganizationId;
    if (activeOrganizationId !== undefined) {
      const internal = await this.service.findByName({ access, name: nameOrKey, organizationId: activeOrganizationId });
      if (internal) return internal;
    }
    return this.service.findByName({ access, name: nameOrKey });
  }

  /** 不存在与不可见返回同一个 undefined：区分两者会让资源 ID 成为跨组织探测面。 */
  private async findVisibleById(actor: ActorContext, resourceId: string): Promise<ScopedSkillRow | undefined> {
    return this.service.findById({ access: await this.listConstraint(actor, "read"), resourceId });
  }

  private async requireVisible(actor: ActorContext, nameOrKey: string): Promise<ScopedSkillRow> {
    const row = await this.findVisible(actor, nameOrKey);
    if (!row) throw new NotFoundError(`Skill '${nameOrKey}' not found`);
    return row;
  }

  private async requireVisibleById(actor: ActorContext, resourceId: string): Promise<ScopedSkillRow> {
    const row = await this.findVisibleById(actor, resourceId);
    if (!row) throw new NotFoundError(`Skill '${resourceId}' not found`);
    return row;
  }

  /** 写入后的回读；查不到即报错，不返回形状不完整的条目。 */
  private async requireItemById(actor: ActorContext, resourceId: string, label: string): Promise<SkillListItem> {
    const row = await this.findVisibleById(actor, resourceId);
    if (!row) throw new NotFoundError(`Skill '${label}' not found`);
    return this.toListItem(await this.withAccess(actor, row));
  }

  /** 把平台的授权拒绝映射为对外 403；其它错误保持原样。 */
  private async requireAction(actor: ActorContext, action: ResourceAction, resourceId: string): Promise<void> {
    try {
      await this.authorizeAction(actor, action, resourceId);
    } catch (error) {
      if (error instanceof ResourceAccessDeniedError) throw new ForbiddenError(error.message);
      throw error;
    }
  }

  /** 创建期归属与 `create` 判定；拒绝映射为对外 403。 */
  private async resolveCreateScope(actor: ActorContext): Promise<ResourceScope> {
    try {
      return await this.resolveInitialScope(actor);
    } catch (error) {
      if (error instanceof ResourceAccessDeniedError) throw new ForbiddenError(error.message);
      throw error;
    }
  }

  private async deleteRow(row: ScopedSkillRow, label: string): Promise<void> {
    const deleted = await this.service.remove({ resourceId: row.id });
    if (!deleted) throw new NotFoundError(`Skill '${label}' not found`);
    await deleteSkillDocument({ organizationId: row.organizationId, name: row.name });
  }

  /**
   * 创建失败的补偿：删除刚建的行。
   *
   * 补偿失败不掩盖原始错误（`cause` 会原样上抛给调用方），只记录清理失败，避免残留行被误认为创建
   * 成功——它与内容已经不同步，下一次导入或创建会因唯一索引报冲突。
   */
  private async rollbackCreate(resourceId: string, name: string, cause: unknown): Promise<void> {
    await this.service.remove({ resourceId }).catch((error) => {
      log.warn("Skill 创建回滚失败：资源行未被删除", {
        resourceId,
        name,
        cause: cause instanceof Error ? cause.message : String(cause),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** 导入回滚：把被覆盖的资源行恢复为导入前的内容（归属列与 `visibility` 不在本次写入范围内）。 */
  private async restoreOverwritten(row: ScopedSkillRow): Promise<void> {
    await this.service.upsertByOrgAndName({
      name: row.name,
      data: restoreWriteData(row),
      organizationId: row.organizationId,
      ownerUserId: row.userId,
    });
  }
}

/** 从既有行取出可回写的描述与元数据（`metadata` 是 jsonb，非字符串表时按缺省处理）。 */
function restoreWriteData(row: ScopedSkillRow): SkillWriteData {
  const metadata = toSkillMetadata(row.metadata);
  return {
    description: row.description ?? undefined,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** 内容层的校验错误（裸 Error + `code`）归一为宿主 `ValidationError`；不是校验错误时返回 null。 */
function toValidationError(error: unknown): ValidationError | null {
  if (error instanceof Error && "code" in error && error.code === "VALIDATION_ERROR") {
    return new ValidationError(error.message);
  }
  return null;
}
