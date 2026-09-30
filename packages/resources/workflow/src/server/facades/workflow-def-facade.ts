/**
 * Workflow 的资源应用 Facade：`route → Facade → Domain Service / Repository` 的应用入口。
 *
 * 本包此前没有这一层，四条 `/web/workflow*` 路由直接调用 `repositories/workflow-def` 的函数，并在
 * 处理器里把会话上下文拆成 `organizationId` / `userId` 就地传参。这有两处问题：
 *   1. **越层**：路由依赖持久化模块，仓储函数签名一变，协议适配代码跟着改；
 *   2. **身份透传**：路由手上是宿主的认证上下文（含 `role` / `memberships` 等身份语义），把它交给
 *      持久层等于让存储看到身份数据——即使它只读其中两个字段。
 *
 * 本层只做一件事：**把 actor 换成显式范围**。每个方法从 {@link WorkflowActor} 推导仓储需要的
 * `organizationId`（以及写入归属需要的 `userId`），路由不再知道组织从哪来。
 *
 * 授权来源：workflow 不在五张受控资源主表之列（无 `visibility`），包内不复制 `@fenix/access-control`
 * 的规则。它的租户边界就是「会话守卫已认证的 active organization」——由宿主 `apps/server` 的认证插件
 * 保证，本包只消费 `store.authContext`；Facade 把它落成每条查询/写入的组织谓词，因此跨组织读取与跨组织
 * SSE 订阅在 SQL 层面不可能发生。
 *
 * 失败语义与迁移前逐条一致，本层不吞错、不改写：不存在返回 `null` / `false`（由路由映射 404），
 * 仓储与领域服务抛出的 `Error`（如「发布时无草稿」「版本不存在」）原样上抛。
 *
 * 边界：runtime / engine 侧的对象（`getTeamEngine`、`createPgStorageAdapter`、实例清理）仍由路由按
 * 组织键取用——它们是按租户隔离的运行时组合物，不是资源数据的取数入口，放进本层会把 Facade 变成
 * 运行时装配面。
 */

import type { WorkflowDefRow, WorkflowVersionRow } from "../repositories/workflow-def";
import {
  createWorkflowDef,
  deleteWorkflowDef,
  getVersions,
  getVersionYaml,
  getWorkflowDef,
  linkWorkflowSnapshotToWorkflow,
  listRecoverableWorkflows,
  listWorkflowDefs,
  publishVersion,
  recoverWorkflows,
  restoreVersionToDraft,
  saveDraft,
  setLatestVersion,
  updateWorkflowMeta,
} from "../repositories/workflow-def";
import type { ResolveYamlDeps } from "../services/workflow/resolve-yaml";
import { resolveYaml as resolveYamlFromPayload } from "../services/workflow/resolve-yaml";
import type { TriggerView } from "../services/workflow-trigger";
import {
  createTrigger,
  deleteTrigger,
  disableTrigger,
  enableTrigger,
  listTriggers,
  regenerateHash,
} from "../services/workflow-trigger";

/**
 * 本 Facade 接受的最小主体投影。
 *
 * 与宿主认证守卫写入 `store.authContext` 的形状（`routes/dependencies` 的 `WorkflowActorContext`）结构
 * 一致：宿主传入更宽的对象天然满足本类型，而本层不读取这两个字段以外的任何身份信息。角色与成员关系
 * 不在这里解释——workflow 的授权就是「同组织」，跨组织可见性不由本包定义。
 */
export interface WorkflowActor {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * `resolveYaml` 的取数端口：在本层组装，使领域服务既不认识 actor 也不需要自己 import 仓储。
 *
 * 端口类型刻意保持仓储函数签名（服务层已有用例以此注入替身），因此这里不做二次包装。
 */
const yamlReader: ResolveYamlDeps = { getWorkflowDef, getVersionYaml };

/** 触发器的创建输入中「归属」以外的部分；组织与创建者由本层从 actor 推导。 */
export interface WorkflowTriggerInput {
  readonly type?: string;
  readonly config?: Record<string, unknown>;
}

/**
 * Workflow 定义与触发器的应用接口。
 *
 * 路由只依赖这组方法，不依赖仓储函数签名；用例可以提供实现而不触达真实数据库。
 */
export interface WorkflowDefFacade {
  /** 当前组织的工作流定义列表。 */
  list(actor: WorkflowActor): Promise<WorkflowDefRow[]>;
  /** 扫描文件系统中存在、数据库无记录的工作流 ID（只扫当前组织的目录）。 */
  listRecoverable(actor: WorkflowActor): Promise<string[]>;
  /** 把孤立工作流目录恢复为数据库记录，归属记为 actor 本人。 */
  recover(actor: WorkflowActor, workflowIds: string[]): Promise<WorkflowDefRow[]>;
  /** 创建定义；`userId` / `organizationId` 取 actor，请求体里的同名值不被采信。 */
  create(actor: WorkflowActor, data: { name: string; description?: string }): Promise<WorkflowDefRow>;
  /** 按 ID 读取定义；组织内不存在时返回 `null`（跨组织读与不存在不可区分，避免探测他人资源）。 */
  get(actor: WorkflowActor, workflowId: string): Promise<WorkflowDefRow | null>;
  /** 删除定义与其 YAML 目录；未命中返回 `false`。 */
  remove(actor: WorkflowActor, workflowId: string): Promise<boolean>;
  /** 更新名称 / 描述；未命中返回 `null`。 */
  updateMeta(
    actor: WorkflowActor,
    workflowId: string,
    data: { name?: string; description?: string },
  ): Promise<WorkflowDefRow | null>;
  /** 列出定义的已发布版本。 */
  listVersions(actor: WorkflowActor, workflowId: string): Promise<WorkflowVersionRow[]>;
  /**
   * 读取指定版本的 YAML（`version=0` 为草稿）。
   *
   * `options.storagePath` 由调用方从已读到的定义行带入，用于跳过重复的定位查询；组织仍由本层注入，
   * 调用方无法用它越过组织边界。
   */
  getVersionYaml(
    actor: WorkflowActor,
    workflowId: string,
    version: number,
    options?: { storagePath?: string | null },
  ): Promise<string | null>;
  /** 保存草稿（upsert `version=0`）；无定义时由仓储抛错。 */
  saveDraft(actor: WorkflowActor, workflowId: string, yaml: string): Promise<void>;
  /** 发布草稿为新版本（行锁保证并发下版本号不重复）；无草稿时由仓储抛错。 */
  publish(actor: WorkflowActor, workflowId: string): Promise<WorkflowVersionRow>;
  /** 把 latest 指针指回指定版本。 */
  setLatestVersion(actor: WorkflowActor, workflowId: string, version: number): Promise<void>;
  /** 把已发布版本的内容恢复为草稿。 */
  restoreVersionToDraft(actor: WorkflowActor, workflowId: string, version: number): Promise<void>;
  /** 从请求载荷解析要执行的 YAML（直传 yaml 优先，否则按 workflowId + version 读取）。 */
  resolveYaml(actor: WorkflowActor, payload: Record<string, unknown>): Promise<string | null>;
  /** 把引擎生成的运行快照回填到所属工作流。 */
  linkSnapshot(actor: WorkflowActor, runId: string, workflowId: string): Promise<void>;
  /** 为指定工作流创建触发器；创建者取 actor 本人。 */
  createTrigger(actor: WorkflowActor, workflowId: string, input: WorkflowTriggerInput): Promise<TriggerView>;
  /** 列出工作流的触发器（返回 masked 视图，不含完整 hash）。 */
  listTriggers(actor: WorkflowActor, workflowId: string): Promise<TriggerView[]>;
  /** 删除触发器；未命中返回 `false`。 */
  deleteTrigger(actor: WorkflowActor, triggerId: string): Promise<boolean>;
  /** 重新生成触发器 hash；未命中返回 `null`。 */
  regenerateTriggerHash(actor: WorkflowActor, triggerId: string): Promise<TriggerView | null>;
  /** 启用触发器；未命中返回 `false`。 */
  enableTrigger(actor: WorkflowActor, triggerId: string): Promise<boolean>;
  /** 停用触发器；未命中返回 `false`。 */
  disableTrigger(actor: WorkflowActor, triggerId: string): Promise<boolean>;
}

/**
 * 仓储的写入接口当前以 `{ organizationId, userId }` 两项作为归属载体，本层在此**重新构造**该最小对象，
 * 而不是把宿主认证上下文原样下传：持久层不应看到 `role` / `memberships` 之类的身份语义。
 */
function ownershipOf(actor: WorkflowActor): { organizationId: string; userId: string } {
  return { organizationId: actor.organizationId, userId: actor.userId };
}

/** 进程级无状态实现；Facade 不持有连接、缓存或 actor。 */
export const workflowDefFacade: WorkflowDefFacade = {
  list: (actor) => listWorkflowDefs(actor.organizationId),

  listRecoverable: (actor) => listRecoverableWorkflows(actor.organizationId),

  recover: (actor, workflowIds) => recoverWorkflows(ownershipOf(actor), workflowIds),

  create: (actor, data) => createWorkflowDef(ownershipOf(actor), data),

  get: (actor, workflowId) => getWorkflowDef(workflowId, actor.organizationId),

  remove: (actor, workflowId) => deleteWorkflowDef(workflowId, actor.organizationId),

  updateMeta: (actor, workflowId, data) => updateWorkflowMeta(workflowId, actor.organizationId, data),

  listVersions: (actor, workflowId) => getVersions(workflowId, actor.organizationId),

  getVersionYaml: (actor, workflowId, version, options) =>
    getVersionYaml(workflowId, version, {
      organizationId: actor.organizationId,
      storagePath: options?.storagePath,
    }),

  saveDraft: (actor, workflowId, yaml) => saveDraft(workflowId, ownershipOf(actor), yaml),

  publish: (actor, workflowId) => publishVersion(workflowId, ownershipOf(actor)),

  setLatestVersion: (actor, workflowId, version) => setLatestVersion(workflowId, actor.organizationId, version),

  restoreVersionToDraft: (actor, workflowId, version) => restoreVersionToDraft(workflowId, ownershipOf(actor), version),

  resolveYaml: (actor, payload) => resolveYamlFromPayload(payload, actor.organizationId, yamlReader),

  linkSnapshot: (actor, runId, workflowId) => linkWorkflowSnapshotToWorkflow(runId, actor.organizationId, workflowId),

  createTrigger: (actor, workflowId, input) =>
    createTrigger({
      organizationId: actor.organizationId,
      workflowId,
      type: input.type ?? "webhook",
      userId: actor.userId,
      config: input.config,
    }),

  listTriggers: (actor, workflowId) => listTriggers(workflowId, actor.organizationId),

  deleteTrigger: (actor, triggerId) => deleteTrigger(triggerId, actor.organizationId),

  regenerateTriggerHash: (actor, triggerId) => regenerateHash(triggerId, actor.organizationId),

  enableTrigger: (actor, triggerId) => enableTrigger(triggerId, actor.organizationId),

  disableTrigger: (actor, triggerId) => disableTrigger(triggerId, actor.organizationId),
};
