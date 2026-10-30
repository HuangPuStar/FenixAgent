import type { ActorContext, AuthorizedResource } from "@fenix/platform-sdk";
import type { ModelRepository, ModelRow, ModelWriteData } from "../repositories/model-resource";
import type { ProviderWriteData, ScopedProviderRow } from "../repositories/provider-resource";
import type { ProviderService } from "../services/provider-service";

/** 带当前主体有效动作的 Provider 资源行；`access.actions` 是 `/web` 视图与 `/api` 视图的共同来源。 */
export type AuthorizedProvider = AuthorizedResource<ScopedProviderRow>;

/** 列表项；`modelCount` 由一次批量计数查询补齐，不是逐行 N+1。 */
export interface AuthorizedProviderListItem extends AuthorizedProvider {
  readonly modelCount: number;
}

/** 详情；`models` 是该 Provider 下的全部子行（列表场景不加载，避免 N+1）。 */
export interface AuthorizedProviderDetail extends AuthorizedProvider {
  readonly models: readonly ModelRow[];
}

/**
 * 子行分页列表：Provider 的授权视图 + 当前页子行 + 子行全集计数。与 {@link AuthorizedProviderDetail}
 * 分开是读法不同：详情把子行全量嵌进 Provider，列表的分页只能在 SQL 完成（决策 D3）。
 */
export interface AuthorizedProviderModelsPage extends AuthorizedProvider {
  readonly items: readonly ModelRow[];
  readonly total: number;
}

/**
 * 定位 Provider 资源行。
 *
 * `/web` 与 `/api` 管理接口使用资源 ID；名称入口保留给内部配置解析。
 */
export type ProviderRef =
  | { readonly by: "nameOrKey"; readonly value: string }
  | { readonly by: "resourceId"; readonly value: string };

/**
 * 定位 Model 子表行。
 *
 * 管理接口使用行 ID；上游模型代码用于运行时解析。
 */
export type ModelRef =
  | { readonly by: "modelId"; readonly value: string }
  | { readonly by: "id"; readonly value: string };

/** 写入选项；不传 `publicReadable` 表示"只改配置，不动公开受众"。 */
export interface ProviderWriteOptions {
  readonly publicReadable?: boolean;
}

/** 子表写操作的结果：受影响的行标识 + 回读后的 Provider 详情。 */
export interface ProviderModelWriteResult {
  readonly id: string;
  readonly provider: AuthorizedProviderDetail;
  readonly modelId: string;
}

/**
 * Provider 资源的应用接口（Facade 的契约面）。
 *
 * 路由与其它调用方只依赖本接口，不依赖 `ProviderFacade` 的继承结构或私有依赖。
 */
export interface ProviderFacadeApi {
  list(
    actor: ActorContext,
    options?: { limit?: number; offset?: number },
  ): Promise<{ items: AuthorizedProviderListItem[]; total: number }>;
  /** 名称或资源键（`<organizationId>/<resourceId>`）定位详情。 */
  get(actor: ActorContext, nameOrKey: string): Promise<AuthorizedProviderDetail | undefined>;
  /** 资源 ID 定位详情（已发布的 `/api/models`）。 */
  getById(actor: ActorContext, resourceId: string): Promise<AuthorizedProviderDetail | undefined>;
  /**
   * 连通性探测的目标读取：与 {@link ProviderFacadeApi.get} 返回同一形状，但要求 `update` 动作。
   *
   * 探测会拿组织的密钥向上游发起真实请求，并把上游返回的模型清单/错误正文回显到控制台，因此它按
   * "配置管理"而不是"只读查看"授权。迁移前这一步用 `assertInternalWritable` 把关，那条判断只比较
   * 归属组织、不看角色，等于允许任一组织成员用组织凭据打上游；同时它也把跨组织公开的 Provider 挡在
   * 外面（而 `read` 会放行它们，那等于让外部读者消耗本组织的密钥，方向正好相反）。改用 `update`
   * 后，只有能改这份配置的人才能探测它。
   *
   * 与 {@link ProviderFacadeApi.getWritable} 的唯一差别：**系统托管的 gateway Provider 允许探测**，
   * 它的连通性正是运维最需要确认的信息，而探测不写任何配置。
   */
  getForProbe(actor: ActorContext, ref: ProviderRef): Promise<AuthorizedProviderDetail | undefined>;
  /**
   * 子表写入前的读取：可见 → 非系统托管 → 拿到 `update` 动作。
   *
   * Model 子表的全部写操作（增/改/删）都要先读到子行快照才能判重、才能拿到写之前的 `modelId`；
   * 三条判定与写操作本身的前置完全一致，因此合为一个入口，避免路由自己按顺序调三段。
   *
   * 不可见时抛 `NotFoundError`（而不是返回 `undefined`）：调用方都是写路径，"看不到"与"不存在"
   * 对它们没有区别，都不该继续往下走。
   */
  getWritable(actor: ActorContext, ref: ProviderRef): Promise<AuthorizedProviderDetail>;
  /** 显式创建，名称冲突返回 409，不更新已有资源。 */
  create(
    actor: ActorContext,
    name: string,
    data: ProviderWriteData,
    options?: ProviderWriteOptions,
  ): Promise<AuthorizedProviderDetail>;
  /** 名称入口的幂等保存：存在则更新，不存在则创建。 */
  save(
    actor: ActorContext,
    name: string,
    data: ProviderWriteData,
    options?: ProviderWriteOptions,
  ): Promise<AuthorizedProviderDetail>;
  /** 资源 ID 入口的更新（已发布的 `/api/models`）；不存在或不满足 `update` 都不写。 */
  saveById(
    actor: ActorContext,
    resourceId: string,
    data: ProviderWriteData,
    options?: ProviderWriteOptions,
  ): Promise<AuthorizedProviderDetail>;
  remove(actor: ActorContext, ref: ProviderRef): Promise<void>;
  /**
   * 子行分页列表；定位与授权跟 {@link ProviderFacadeApi.getById} 同一套（不可见即 `undefined`），但只读
   * 当前页子行并给出子行全集计数——分页必须下推到 SQL，取回全量再切片会把整张子表读进进程（决策 D3）。
   */
  listModels(
    actor: ActorContext,
    ref: ProviderRef,
    options?: { limit?: number; offset?: number },
  ): Promise<AuthorizedProviderModelsPage | undefined>;
  /** 新增 Model 子行；需要 Provider 的 `update` 动作。 */
  addModel(
    actor: ActorContext,
    ref: ProviderRef,
    modelId: string,
    data: ModelWriteData,
  ): Promise<ProviderModelWriteResult>;
  /** 更新 Model 子行；需要 Provider 的 `update` 动作。 */
  updateModel(
    actor: ActorContext,
    ref: ProviderRef,
    modelRef: ModelRef,
    data: ModelWriteData,
  ): Promise<ProviderModelWriteResult>;
  /** 删除 Model 子行；需要 Provider 的 `update` 动作。 */
  removeModel(actor: ActorContext, ref: ProviderRef, modelRef: ModelRef): Promise<ProviderModelWriteResult>;
}

/** Facade 的领域依赖；授权依赖经基类的 options 传入。 */
export interface ProviderFacadeDeps {
  readonly service: ProviderService;
  readonly models: ModelRepository;
}
