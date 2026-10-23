import type { ActorContext, ResourceAccess, ResourceScope } from "@fenix/platform-sdk";
import type { ImportConflictStrategy, ImportSkillsConflict, UploadSkillFile } from "../services/skill-content";

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
 * 单资源导入结果：成功携带回读后的详情，命中本组织同名资源时携带冲突名。
 *
 * 冲突不是异常而是"需要调用方决策"的状态：控制台把它映射成带策略选项的 409，对外接口映射成纯 409。
 * 两者共用同一次导入与同一份冲突判定，差别只在协议表达。
 */
export type SkillSingleImportResult =
  | { readonly status: "imported"; readonly detail: SkillDetailView }
  | { readonly status: "conflict"; readonly name: string };

/** 单资源导入选项；`overwrite` 为真时覆盖本组织同名资源，否则冲突原样上报。 */
export interface SkillSingleImportOptions {
  readonly overwrite?: boolean;
}

/**
 * Skill 资源的应用接口（Facade 的契约面）。
 *
 * 路由与其它调用方只依赖本接口，不依赖 `SkillFacade` 的继承结构或私有依赖；测试可以提供实现而不
 * 构造真类（见 `@fenix/resource-skill/server/testing`）。
 *
 * 名称 / 资源键与资源 ID 两组入口并存是协议需要：`/web` 与 `/api` 管理接口使用资源 ID；名称入口仅供仍需按名称解析的内部流程。
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
  /** 按资源 ID 更新文档，保留文件快照与失败回滚。 */
  updateById(
    actor: ActorContext,
    resourceId: string,
    data: Partial<SkillWriteInput>,
    options?: SkillUpdateOptions,
  ): Promise<SkillListItem>;
  /** 按资源 ID 修改公开受众。 */
  setPublicReadableById(actor: ActorContext, resourceId: string, publicReadable: boolean): Promise<SkillListItem>;
  /** 仅更新公开受众，不读取、不解析、不改写 SKILL.md。 */
  setPublicReadable(actor: ActorContext, nameOrKey: string, publicReadable: boolean): Promise<SkillListItem>;
  remove(actor: ActorContext, nameOrKey: string): Promise<void>;
  removeById(actor: ActorContext, resourceId: string): Promise<void>;
  importDirectories(
    actor: ActorContext,
    files: UploadSkillFile[],
    strategy?: ImportConflictStrategy,
  ): Promise<SkillImportResult>;
  /**
   * 上传导入**单个** Skill 目录，并回读导入后的详情（对外 `/api/skills` 已发布合同的上传语义）。
   *
   * 与 {@link SkillFacadeApi.importDirectories} 同为一次上传的两个产品口径，共用同一套写入、冲突判定、
   * 回滚与授权：控制台允许多目录上传并由用户选择冲突策略，对外接口一次只接受一个目录、冲突直接上报。
   */
  importSingleSkill(
    actor: ActorContext,
    files: UploadSkillFile[],
    options?: SkillSingleImportOptions,
  ): Promise<SkillSingleImportResult>;
}
