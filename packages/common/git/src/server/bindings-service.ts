/**
 * 管理服务与作用域客户端的工厂（组合根的一部分）。
 *
 * 两条路径刻意分开，凭据不同、能力不同：
 * - **管理动作**（建仓库、开 Issues、注册绑定）走连接的 `adminClient`——它持有 provision token，能建仓库与
 *   Webhook，只允许初始化脚本与宿主管理接口调用；
 * - **日常读写**走按绑定 `credentialRef` 解析出的受限服务凭据，普通业务（工单等）只能拿到这一层。
 *
 * 本文件不做调用方授权：那是宿主管理接口的职责（组织管理员只能选择本组织已授权的连接与仓库）。包内只判定
 * 自己能判定的事——凭据引用是否合法且已声明、上游仓库是否真的存在、同一仓库是否已归属别的组织。
 */

import type {
  BindExistingRepositoryInput,
  CreateGitScopedClientInput,
  GitAdminService,
  GitRepositoryBindingView,
  GitScopedClient,
} from "../contracts/client";
import { GitError, isGitError } from "../contracts/errors";
import type { GitRepository, RepositoryRef } from "../contracts/types";
import { ForgejoClient } from "../forgejo/client";
import type { GitConnectionConfig } from "./config";
import { type GitBindingRecord, gitBindingRepo } from "./repositories/bindings";
import { createScopedClientFromBinding } from "./scoped-client";

/**
 * `{env:NAME}` 引用语法。
 *
 * 与配置文件同一套规则，但这里**独立实现**：解析失败的错误码不同（配置文件是启动期 `Error`，绑定是运行期
 * 的 `FORBIDDEN`），共用实现会把两处语义绑死。语法本身很短，重复一份比造抽象更便宜。
 */
const ENV_REF_PATTERN = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Forgejo 的仓库 ID 是非零十进制整数；它是绑定唯一键的一部分，不允许别的形状混进来。 */
const DECIMAL_ID = /^[1-9]\d*$/;

/** 一个已配置连接的装配结果。 */
export interface GitConnectionDeps {
  readonly config: GitConnectionConfig;
  /** 用 provision token 构造的适配器（管理动作专用）。 */
  readonly adminClient: ForgejoClient;
}

export interface GitBindingsServiceDeps {
  /** 连接 id → 装配结果；id 来自 `AOS_GIT_CONFIG_FILE`。 */
  readonly connections: ReadonlyMap<string, GitConnectionDeps>;
  /** 宿主注入的密钥值表（只含 Git manifest 已声明的 secret 键），用于解析 `credentialRef`。 */
  readonly secrets: Readonly<Record<string, string>>;
}

/** 管理服务 + 普通消费者的作用域客户端入口（`GitService` 的两半都来自这里）。 */
export type GitBindingsService = GitAdminService & {
  createScopedClient(input: CreateGitScopedClientInput): Promise<GitScopedClient>;
};

/**
 * 构造绑定服务。
 *
 * `createScopedClient` 只做装配：组织归属、consumer 授权与每次操作的复查都在
 * {@link createScopedClientFromBinding} 返回的客户端里完成，这里不重复判定。
 */
export function createBindingsService(deps: GitBindingsServiceDeps): GitBindingsService {
  /**
   * 每绑定一个适配器实例：适配器持有本绑定的并发闸，同一绑定的所有调用共享它。每次调用新建实例等于让绑定级
   * 限流形同虚设（N 个并发调用就有 N 个闸）。条目按绑定 ID 缓存，数量与进程内真正用到的绑定同阶，且每条只是
   * 配置加一个信号量——不引入过期或 LRU。凭据轮换（引用改指别的密钥）时重建，旧 token 不会继续出站。
   */
  const scopedClients = new Map<string, { readonly token: string; readonly client: ForgejoClient }>();

  function requireConnection(connectionId: string): GitConnectionDeps {
    const connection = deps.connections.get(connectionId);
    if (connection === undefined) {
      throw new GitError("NOT_FOUND", `连接 ${connectionId} 未在 AOS_GIT_CONFIG_FILE 中配置`);
    }
    return connection;
  }

  /**
   * 校验并解析 `{env:NAME}` 引用，返回凭据值。
   *
   * 未声明的引用与「已声明但值为空」都拒绝：空 token 出站只会在远端变成 401，把「忘配密钥」伪装成外部故障。
   * 消息只带变量名与上下文，绝不回显值。
   */
  function resolveCredentialRef(credentialRef: string, context: string): string {
    const match = ENV_REF_PATTERN.exec(credentialRef);
    if (match === null) {
      throw new GitError("FORBIDDEN", `${context} 必须是 {env:NAME} 形式的密钥引用`);
    }
    const name = match[1];
    const value = deps.secrets[name];
    if (value === undefined) {
      throw new GitError("FORBIDDEN", `${context} 引用了未声明的密钥 ${name}`);
    }
    if (value === "") {
      throw new GitError("FORBIDDEN", `${context} 引用的密钥 ${name} 未提供值`);
    }
    return value;
  }

  function scopedClientFor(
    binding: GitBindingRecord,
    connection: GitConnectionDeps,
    consumerId: string,
  ): GitScopedClient {
    const token = resolveCredentialRef(binding.credentialRef, `绑定 ${binding.id} 的凭据引用`);
    // 初始化凭据不得出现在日常路径上：它能建仓库与 Webhook，一旦被绑定引用，任何拿到该绑定的消费者都间接
    // 获得管理面能力。比对**值**——引用名字合法不代表指向的就是受限凭据。
    if (token === connection.config.provisionToken) {
      throw new GitError("FORBIDDEN", `绑定 ${binding.id} 的凭据引用指向初始化凭据`);
    }

    const cached = scopedClients.get(binding.id);
    let client: ForgejoClient;
    if (cached !== undefined && cached.token === token) {
      client = cached.client;
    } else {
      client = new ForgejoClient({
        baseUrl: connection.config.baseUrl,
        token,
        requestTimeoutMs: connection.config.requestTimeoutMs,
        maxConcurrentRequests: connection.config.maxConcurrentRequests,
      });
      scopedClients.set(binding.id, { token, client });
    }

    return createScopedClientFromBinding({
      binding,
      connection: connection.config,
      consumerId,
      serviceToken: token,
      client,
    });
  }

  return {
    async createScopedClient(input: CreateGitScopedClientInput): Promise<GitScopedClient> {
      const binding = await gitBindingRepo.findById(input.bindingId);
      if (binding === null) {
        throw new GitError("NOT_FOUND", `仓库绑定 ${input.bindingId} 不存在`);
      }
      // 归属判定只发生在创建期：作用域一旦建成，组织就取自绑定本身，不再接受调用方传入的组织。错误消息不说明
      // 绑定属于哪个组织——那会把其他租户的标识透给未授权的调用方。
      if (binding.organizationId !== input.organizationId) {
        throw new GitError("FORBIDDEN", `仓库绑定 ${binding.id} 不属于当前组织`);
      }
      return scopedClientFor(binding, requireConnection(binding.connectionId), input.consumerId);
    },

    async createPrivateRepository(
      connectionId: string,
      input: { owner: string; name: string; description?: string | null },
    ): Promise<GitRepository> {
      const connection = requireConnection(connectionId);
      try {
        const created = await connection.adminClient.createRepository({
          owner: input.owner,
          name: input.name,
          description: input.description ?? null,
        });
        // 适配器只认 baseUrl，不知道自己是哪个连接（创建响应里拿不到 connectionId），组合根必须补齐；空串
        // 一旦带回调用方，这个 ref 就无法再按连接寻址。
        return { ...created, ref: { ...created.ref, connectionId } };
      } catch (error) {
        // 上游把「同名已存在」报成 409，这是幂等重跑（bootstrap 反复执行）的正常路径，不是失败。
        if (!isGitError(error) || error.code !== "CONFLICT") throw error;
        return await readExistingAfterConflict(connection, connectionId, input, error);
      }
    },

    async getRepository(connectionId: string, ref: Omit<RepositoryRef, "connectionId">): Promise<GitRepository> {
      return requireConnection(connectionId).adminClient.getRepository({ connectionId, ...ref });
    },

    async ensureIssuesEnabled(connectionId: string, ref: Omit<RepositoryRef, "connectionId">): Promise<GitRepository> {
      return requireConnection(connectionId).adminClient.setRepositoryIssuesEnabled({ connectionId, ...ref });
    },

    async bindExistingRepository(input: BindExistingRepositoryInput): Promise<GitRepositoryBindingView> {
      const connection = requireConnection(input.connectionId);
      // 写库前校验凭据引用：一行引用未声明密钥的绑定要到第一次调用才暴露，运维得翻库才知道原因。
      resolveCredentialRef(input.credentialRef, `绑定 ${input.connectionId} 的凭据引用`);
      const providerRepositoryId = requireProviderRepositoryId(input.providerRepositoryId);
      const ref: RepositoryRef = {
        connectionId: input.connectionId,
        providerRepositoryId,
        owner: input.owner,
        name: input.name,
      };
      // 上游存在性校验：坐标打错（或凭据对该仓库不可见）应当在这里失败，而不是留下一行读不到的绑定。
      await connection.adminClient.getRepository(ref);

      const existing = await gitBindingRepo.findByConnectionAndRepository(input.connectionId, providerRepositoryId);
      if (existing !== null && existing.organizationId !== input.organizationId) {
        throw new GitError("CONFLICT", `仓库 ${input.owner}/${input.name} 已绑定到其他组织，跨组织共享不在本次范围内`);
      }

      const record = await gitBindingRepo.upsert({
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        providerRepositoryId,
        owner: input.owner,
        name: input.name,
        credentialRef: input.credentialRef,
        allowedConsumers: input.allowedConsumers,
      });
      // 写前检查与写入之间有窗口：仓储在冲突时把 organizationId 钉在原值上（不接管归属），所以这里复核返回值。
      // 窗口内被别的组织抢先写入时拒绝，而不是把一行不属于当前组织的绑定当成功返回。
      if (record.organizationId !== input.organizationId) {
        throw new GitError("CONFLICT", `仓库 ${input.owner}/${input.name} 已绑定到其他组织，跨组织共享不在本次范围内`);
      }
      return toBindingView(record);
    },

    async getBinding(bindingId: string): Promise<GitRepositoryBindingView> {
      const binding = await gitBindingRepo.findById(bindingId);
      if (binding === null) {
        throw new GitError("NOT_FOUND", `仓库绑定 ${bindingId} 不存在`);
      }
      return toBindingView(binding);
    },
  };
}

/**
 * 建仓库撞上「同名已存在」后的回读，把 409 变成幂等返回。
 *
 * 回读必须拿到**真实仓库 ID**：绑定记录的唯一键是 `(connection_id, provider_repository_id)`，一个空 ID 或
 * 猜错的 ID 被拿去绑定，就会写下一行永远对不上上游的绑定。而 `POST /user/repos` 的 409 响应不含 ID，适配器
 * 的读入口又以调用方传入的 ref 为权威坐标——因此 ID 只能取自本包已有的绑定记录，也就是「重跑 bootstrap」
 * 这一最常见的情形。
 *
 * 查不到绑定（仓库存在但 AOS 从未见过它）时**不返回半成品**，直接报 CONFLICT：把「这个仓库到底是谁」交回给
 * 掌握完整信息的调用方去显式绑定，而不是让一个 ID 为空的 ref 继续往下流。
 */
async function readExistingAfterConflict(
  connection: GitConnectionDeps,
  connectionId: string,
  input: { readonly owner: string; readonly name: string },
  conflict: GitError,
): Promise<GitRepository> {
  const existing = await gitBindingRepo.findByOwnerAndName(connectionId, input.owner, input.name);
  if (existing === null) {
    throw new GitError(
      "CONFLICT",
      `仓库 ${input.owner}/${input.name} 已存在，但没有可用的绑定记录来确定仓库 ID；请显式绑定该仓库`,
      { cause: conflict, operationId: conflict.operationId },
    );
  }

  const ref: RepositoryRef = {
    connectionId,
    providerRepositoryId: existing.providerRepositoryId,
    owner: input.owner,
    name: input.name,
  };
  try {
    return await connection.adminClient.getRepository(ref);
  } catch (error) {
    // 冲突这一事实比回读失败的细节更重要：调用方据此判断「名字被占」，回读错误挂在 cause 上供排障。
    throw new GitError("CONFLICT", `仓库 ${input.owner}/${input.name} 已存在但回读失败`, {
      cause: error,
      operationId: conflict.operationId,
    });
  }
}

/**
 * 校验调用方给出的仓库 ID。
 *
 * 空串与非十进制串一律判为 NOT_FOUND：它们指不到任何上游仓库，写进唯一键只会留下一行永远匹配不上的绑定。
 */
function requireProviderRepositoryId(value: string): string {
  if (!DECIMAL_ID.test(value)) {
    throw new GitError("NOT_FOUND", "providerRepositoryId 不是合法的仓库 ID");
  }
  return value;
}

/** 绑定行 → 管理面投影；`allowedConsumers` 直接透传，调用方看到的就是当前生效的授权集合。 */
function toBindingView(record: GitBindingRecord): GitRepositoryBindingView {
  return {
    id: record.id,
    organizationId: record.organizationId,
    connectionId: record.connectionId,
    repository: {
      connectionId: record.connectionId,
      providerRepositoryId: record.providerRepositoryId,
      owner: record.owner,
      name: record.name,
    },
    allowedConsumers: record.allowedConsumers,
    status: record.status,
  };
}
