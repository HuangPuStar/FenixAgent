/**
 * 通道绑定的资源应用 Facade：`route → Facade → Domain Service → Repository` 的应用入口。
 *
 * 立这一层之前的形态是：路由把会话上下文里的 `organizationId` 与 Environment 归属查询就地拼在一起，
 * 在处理器内做「绑定目标 Environment 属不属于调用者组织」的比较，并把「先 `listBindings()` 读全表、
 * 再在内存里按环境 ID 过滤」当作列表的可见性实现。那让组织隔离规则有了第二个落点（协议层），
 * 列表的过滤也发生在数据库之外——表一大就是全表扫描。
 *
 * 现在拆成三件各自可测的事：
 *   - **本层**：从 actor 取出组织，把组织翻译成 Environment 归属（组织 → 环境 ID 集合），
 *     决定列表可见集与写操作的放行/拒绝；
 *   - **领域服务**（`../services/channel-binding`）：只收显式参数（环境 ID 集合、绑定 ID、字段），
 *     不认识 actor，也不比较组织；
 *   - **仓储**：只把给定的环境 ID 集合下推成 `agent_id IN (...)`，不读成员/角色。
 *
 * 授权来源：通道绑定不在五张受控资源主表之列（表里没有 `visibility` / `organization_id`），因此本包
 * 不接 `@fenix/access-control`、也不复制组织规则。它的租户边界是「绑定目标 Environment 属于调用者的
 * active organization」——Environment 的 owner 是 `@fenix/agent-runtime`，本包经宿主注入的
 * {@link ChannelEnvironmentLookup} 只读 `id` / `name` / `organizationId` 三个字段，不引入包依赖。
 * 跨组织与不存在同形：列表隐藏、写操作按既有协议语义分别给出 404（目标环境不可选）与 403（无权操作
 * 已存在的绑定），与迁移前逐条一致，不新增也不放宽。
 *
 * 失败语义：与迁移前一致的信封（`{ success: false, error: { code, message } }`），由路由映射为
 * 404 / 403；本层不吞错，仓储与领域服务的异常原样上抛。
 */

import type { ChannelBinding, CreateBindingInput, UpdateBindingInput } from "../services/channel-binding";
import {
  createBinding,
  deleteBinding,
  getBinding,
  listBindingsByAgentIds,
  updateBinding,
} from "../services/channel-binding";

/**
 * 本 Facade 接受的最小主体投影。
 *
 * 只取用到的那个字段，不 import 宿主 `AuthContext`（那是 `apps/server` 协议层的类型，包一旦依赖它
 * 就无法独立构建）：绑定的可见性与可写性完全由「目标 Environment 属不属于这个组织」决定，`userId`
 * 与 `role` / `memberships` 都不参与判断（同组织成员的通道绑定管理权限相同，与迁移前一致）。
 * 宿主的 `AuthContext` 是它的结构超集，调用点无需转换。
 */
export interface ChannelBindingActor {
  readonly organizationId: string;
}

/** 绑定视图：领域字段 + 关联 Environment 的展示名；环境不可读（已删除）时名称为 `null`。 */
export interface ChannelBindingView extends ChannelBinding {
  readonly agentName: string | null;
}

/**
 * 失败码。
 *
 * 对外的两个口径必须分开：`NOT_FOUND` 表示「目标不可见或不存在」（跨组织的 Environment 与不存在的
 * Environment 不可区分，避免把他人组织的存在性变成探测面），`FORBIDDEN` 表示「绑定存在但无权操作」。
 * 路由据此映射 404 / 403，取值与迁移前逐条一致。
 */
export type ChannelBindingErrorCode = "NOT_FOUND" | "FORBIDDEN";

/** 本 Facade 的结果信封。 */
export type ChannelBindingResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: { readonly code: ChannelBindingErrorCode; readonly message: string } };

/**
 * 通道绑定的应用接口（Facade 的契约面）。
 *
 * 路由只依赖这组方法；用例可以提供实现而不触达真实数据库。方法的入参是 actor 与协议已校验的请求数据，
 * 组织范围由实现内部推导——调用方无法通过请求体或查询串影响自己读到、写到哪个组织的绑定。
 */
export interface ChannelBindingFacade {
  /** 列出当前组织可见的绑定（目标 Environment 属于 actor 的组织）。 */
  list(actor: ChannelBindingActor): Promise<ChannelBindingView[]>;
  /** 创建绑定：目标 Environment 必须是 actor 组织内的环境，否则 `NOT_FOUND`。 */
  create(actor: ChannelBindingActor, input: CreateBindingInput): Promise<ChannelBindingResult<ChannelBindingView>>;
  /** 删除绑定：绑定不存在 `NOT_FOUND`，目标环境不属于 actor 组织 `FORBIDDEN`。 */
  remove(actor: ChannelBindingActor, bindingId: string): Promise<ChannelBindingResult<null>>;
  /**
   * 更新绑定：原绑定与请求体里的新目标环境都必须属于 actor 组织。
   *
   * `input.agentId` 是不可信输入且是**新**目标，因此与 `create` 同口径校验；改指到别的组织的环境必须在
   * 写入前被拒绝，否则越权写入已经发生，响应还会把该组织的环境名回显给调用者。
   */
  update(
    actor: ChannelBindingActor,
    bindingId: string,
    input: UpdateBindingInput,
  ): Promise<ChannelBindingResult<ChannelBindingView>>;
}

/**
 * 本 Facade 需要的 Environment 归属查询端口（宿主注入，包内不提供实现）。
 *
 * 端口归本层所有而不是归协议层：它给出的「目标 Environment 属不属于这个组织」正是本层授权的输入，
 * 由宿主在装配期用 `@fenix/agent-runtime/server` 的 `environmentRepo` 实现后注入
 * （宿主调用点 `apps/server/src/services/resource-module-ports.ts`）。方向因此保持 `route → Facade`：
 * 路由依赖本层的类型，本层不反向依赖协议模块。
 *
 * 只声明用到的三个字段（id / name / organizationId），不引入 Environment 记录的完整类型——记录字段
 * 改名不波及本层，本包也不必为此声明对 `agent-runtime` 的包依赖。
 */
export interface ChannelEnvironmentLookup {
  /**
   * 按 Environment ID 查其所属组织与展示名。
   *
   * 允许返回 `null`/`undefined`：绑定可能指向已被删除的 Environment，此时本层按「环境不可读」处理
   * （列表补空名称、写操作拒绝），而不是把整次读取判为失败。
   */
  getById(id: string): Promise<{ id: string; name: string; organizationId: string | null } | null | undefined>;
  /** 列出某组织下的 Environment；本层用它把组织翻译成绑定的归属范围（环境 ID 集合）。 */
  listByOrganizationId(organizationId: string): Promise<ReadonlyArray<{ id: string; name: string }>>;
}

/** 本 Facade 的注入依赖；只有宿主注入过的 Environment 归属查询，不持有其它状态。 */
export interface ChannelBindingFacadeDeps {
  readonly environmentLookup: ChannelEnvironmentLookup;
}

const AGENT_NOT_FOUND = { code: "NOT_FOUND", message: "Agent 不存在" } as const;
const BINDING_NOT_FOUND = { code: "NOT_FOUND", message: "绑定不存在" } as const;
const FORBIDDEN = { code: "FORBIDDEN", message: "无权操作此绑定" } as const;

/**
 * 创建 Facade 实例。
 *
 * 依赖从构造处注入（与路由工厂同一份 `environmentLookup`）：Environment 的 owner 是
 * `@fenix/agent-runtime`，本包不得导入它，归属查询只能由宿主提供。
 */
export function createChannelBindingFacade(deps: ChannelBindingFacadeDeps): ChannelBindingFacade {
  const { environmentLookup } = deps;

  /** 按 actor 的组织解析环境的可见性：不属于该组织的环境一律按「不存在」处理。 */
  async function resolveVisibleEnvironment(agentId: string, organizationId: string) {
    const environment = await environmentLookup.getById(agentId);
    if (!environment || environment.organizationId !== organizationId) return;
    return environment;
  }

  return {
    list: async (actor) => {
      // 归属范围先由组织解析成环境 ID 集合，再作为查询条件下推——不在应用层读全表后过滤。
      const environments = await environmentLookup.listByOrganizationId(actor.organizationId);
      // 组织内没有任何 Environment 即可见集为空：直接短路，不发出一次注定为空范围的查询。
      if (environments.length === 0) return [];
      const bindings = await listBindingsByAgentIds(environments.map((environment) => environment.id));
      const views: ChannelBindingView[] = [];
      for (const binding of bindings) {
        // 逐条读环境名：环境查询失败（已删除）时名称为空，而不是把整次列表判为失败。
        const environment = await environmentLookup.getById(binding.agentId);
        views.push({ ...binding, agentName: environment?.name ?? null });
      }
      return views;
    },

    create: async (actor, input) => {
      const environment = await resolveVisibleEnvironment(input.agentId, actor.organizationId);
      if (!environment) return { success: false, error: AGENT_NOT_FOUND };
      const binding = await createBinding(input);
      return { success: true, data: { ...binding, agentName: environment.name ?? null } };
    },

    remove: async (actor, bindingId) => {
      const target = await getBinding(bindingId);
      if (!target) return { success: false, error: BINDING_NOT_FOUND };
      const environment = await resolveVisibleEnvironment(target.agentId, actor.organizationId);
      if (!environment) return { success: false, error: FORBIDDEN };
      const deleted = await deleteBinding(bindingId);
      if (!deleted) return { success: false, error: BINDING_NOT_FOUND };
      return { success: true, data: null };
    },

    update: async (actor, bindingId, input) => {
      const target = await getBinding(bindingId);
      if (!target) return { success: false, error: BINDING_NOT_FOUND };
      const environment = await resolveVisibleEnvironment(target.agentId, actor.organizationId);
      if (!environment) return { success: false, error: FORBIDDEN };

      const nextAgentId = input.agentId;
      if (nextAgentId !== undefined && nextAgentId !== target.agentId) {
        const nextEnvironment = await resolveVisibleEnvironment(nextAgentId, actor.organizationId);
        if (!nextEnvironment) return { success: false, error: AGENT_NOT_FOUND };
      }

      const updated = await updateBinding(bindingId, input);
      if (!updated) return { success: false, error: BINDING_NOT_FOUND };
      const updatedEnvironment = await environmentLookup.getById(updated.agentId);
      return { success: true, data: { ...updated, agentName: updatedEnvironment?.name ?? null } };
    },
  };
}
