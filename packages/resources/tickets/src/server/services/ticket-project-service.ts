/**
 * 工单项目的领域服务：开通（建仓或绑定）、默认切换、启停。
 *
 * 分层口径：本层不接收 `ActorContext`，只收 Facade 已授权后传下来的显式范围（`organizationId` / `actorId`）。
 * 授权判定（谁可以开通、谁可以切换默认）与 404/403 的对外映射**只在 Facade**，这里出现的错误都是领域事实：
 * 上游给不出仓库、owner 声明不实、绑定已归别的组织。
 *
 * 开通的编排顺序是合同 §6.1 的逐条落实，三处顺序不可调换：
 * 1. **先声明幂等再出站**：远端调用之前必须已经在账本里落了 `pending` 行，否则进程崩溃会留下一个「远端
 *    建了仓库、本端一无所知」的孤儿仓库（重试也认不出来）；
 * 2. **外部调用在事务与锁之外**：组织级 advisory lock 只覆盖本地读改写（`advisory-lock.ts` 文件头的偏离
 *    说明），建仓库可能耗时十几秒，占着连接池里的连接去等它就是方案自己禁止的行为；
 * 3. **成功终态与项目写入同一事务**：项目行、默认切换、`succeeded` 三件事要么全成要么全不成，否则会出现
 *    「项目可见但账本说没开通」或反之。
 *
 * 中途失败的收敛（§6.1 步骤 6）：上游**确定**拒绝 → 写 `failed` 并抛出同一个对外错误（同键重放不再重试）；
 * `WRITE_UNCERTAIN` → 写 `uncertain` 并返回 202，远端是否建了仓库未知，交 T03 按预留仓库名回源核对；
 * 其余异常（编程错误、本地 DB 故障）→ **不改状态**，保持 `dispatching` 向上抛，同样交给 T03。
 */

import { createHash } from "node:crypto";
import type { GitRepository, GitRepositoryBindingView, GitService } from "@fenix/git/server";
import type { ResourceQueryConstraint } from "@fenix/platform-sdk";
import { type AppError, ForbiddenError, NotFoundError, ValidationError } from "@fenix/platform-sdk";
import {
  appErrorFromOperationResult,
  GitUnavailableError,
  RepositoryConflictError,
  RepositoryOwnerMismatchError,
  toOperationFailureResult,
} from "../errors";
import { ticketsProjectLockKey, withTicketLock } from "../repositories/advisory-lock";
import type { TicketProjectRepository, TicketProjectRow } from "../repositories/ticket-projects";
import { classifyGitFailure, type GitFailureKind } from "./git-failure";
import { TICKET_OPERATION_STEP, type TicketOperationService } from "./ticket-operation-service";
import { hashTicketRequest, projectProvisionTargetPath } from "./ticket-request-hash";

/** 工单模块在 Git 绑定里的消费者 ID：`allowedConsumers` 的键，写入后不可改名（改名等于静默收回授权）。 */
const TICKET_CONSUMER_ID = "tickets";

/**
 * 日常读写凭据引用；初始化凭据（`AOS_GIT_PROVISION_TOKEN`）**绝不**进绑定记录。
 *
 * 绑定走的是受限服务账号，因此建仓用的管理凭据只在这一步之前的问题上有效，日常读写永远拿不到它。
 */
const TICKET_CREDENTIAL_REF = "{env:AOS_GIT_SERVICE_TOKEN}";

/**
 * 工单模块要求的操作集合（`git_repository_bindings.allowed_consumers` 的值）。
 *
 * 这份清单是**持久化契约**：名字与 `@fenix/git` 的受控操作名逐字对齐，漏一项不会报错，只会让对应动作在
 * 运行期变成 `FORBIDDEN`。T02 实际用到 `repositories.read`（开通报错时回读）与 `issues.write`（建工单），
 * 其余为 T03/T04/T05 的评论、标签与附件预留——绑定是运维动作，收紧容易放宽难，因此一次给全。
 *
 * 已存量的绑定行不会因为这里加了两项就自动获得附件权限：`attachments.*` 只在重新绑定（或运维显式刷新
 * 授权集合）后生效，旧行上的上传/下载会以 `FORBIDDEN` 失败——这是「授权集合是持久化契约」的应有形态，
 * 不做运行期自动放宽（那等于让代码替运维改权限）。
 */
const TICKET_CONSUMER_GRANTS: Readonly<Record<string, readonly string[]>> = {
  [TICKET_CONSUMER_ID]: [
    "repositories.read",
    "issues.read",
    "issues.write",
    "comments.read",
    "comments.write",
    "labels.read",
    "labels.write",
    "attachments.read",
    "attachments.write",
  ],
};

/** 预留仓库名后缀的字符上限：前缀 `aos-tickets-` 之外留足余量（Forgejo 仓库名上限 100 字符）。 */
const RESERVED_NAME_SUFFIX_MAX = 40;

/**
 * 预留仓库名：`aos-tickets-<组织归一化后缀>`（§6.2）。
 *
 * 必须是**确定函数**：T03 的恢复流程要靠它推断「这次开通本该建哪个仓库」，随机名会让回源核对无从下手。
 * 组织 ID 可能含 `org_`、短横线等字符，而 Forgejo 仓库名只接受 `[A-Za-z0-9._-]`，因此先归一化；归一化后
 * 为空（例如 ID 全是符号）时退化为组织 ID 的 sha256 前缀——仍然确定，仍然稳定。
 */
export function reservedRepositoryName(organizationId: string): string {
  const normalized = organizationId
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase()
    .slice(0, RESERVED_NAME_SUFFIX_MAX);
  const suffix =
    normalized.length > 0 ? normalized : createHash("sha256").update(organizationId).digest("hex").slice(0, 16);
  return `aos-tickets-${suffix}`;
}

export interface TicketProjectProvisionInput {
  readonly organizationId: string;
  readonly actorId: string;
  readonly connectionId: string;
  readonly mode: "create" | "bind";
  /** `mode: "bind"` 时 `name` 必填（路由 schema 已保证）；`create` 时省略表示由服务端派生预留名。 */
  readonly repository: { readonly owner: string; readonly name?: string };
  readonly idempotencyKey: string;
}

/**
 * 开通结果。
 *
 * `ok` 携带项目**行**而不是协议视图：视图组装（含身份展示名）属 Facade 层，领域服务不产协议对象。
 * 响应所需的 `operation` 由 Facade 用 `operationId` 读账本（§9.1 的 200 载荷是 `{project, operation}`）。
 */
export type TicketProjectProvisionOutcome =
  | { readonly kind: "ok"; readonly project: TicketProjectRow; readonly operationId: string }
  | { readonly kind: "uncertain"; readonly operationId: string };

export interface TicketProjectService {
  /** 受控读取：授权条件原样交给仓储，由平台编译进同一条 SQL。 */
  listReadable(access: ResourceQueryConstraint): Promise<readonly TicketProjectRow[]>;
  /** 单个受控读取：不存在与不可见同形返回 undefined，由 Facade 统一映射成 404。 */
  findReadable(input: {
    readonly access: ResourceQueryConstraint;
    readonly projectId: string;
  }): Promise<TicketProjectRow | undefined>;
  provision(input: TicketProjectProvisionInput): Promise<TicketProjectProvisionOutcome>;
  /** 切换默认并把状态调整一并纳入同一把组织锁；`status` 省略表示只切换默认。 */
  setDefault(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly status?: "active" | "paused";
  }): Promise<void>;
  /** 启停项目；返回是否命中该行（Facade 据此区分 404）。 */
  setStatus(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly status: "active" | "paused";
  }): Promise<boolean>;
}

export interface TicketProjectServiceDeps {
  readonly projects: TicketProjectRepository;
  readonly operations: TicketOperationService;
  /** 仓库与绑定的唯一出入口：管理动作走 `git.admin`，日常读写走 `createScopedClient`。 */
  readonly git: GitService;
}

export function createTicketProjectService(deps: TicketProjectServiceDeps): TicketProjectService {
  const { projects, operations, git } = deps;

  async function findProjectForReplay(result: Readonly<Record<string, unknown>>): Promise<TicketProjectRow> {
    const projectId = typeof result.projectId === "string" ? result.projectId : undefined;
    // 无授权读取是刻意的：操作行是按 (组织, 主体, 幂等键) 领取的，其绑定结果只能属于那个组织的那个主体，
    // 这里读回的是本端刚提交的事实，不存在跨主体可见性问题。
    const project = projectId === undefined ? undefined : await projects.findByIdUnscoped(projectId);
    if (project === undefined) {
      // 成功终态与项目行在同一事务提交，缺行只可能是人工改库或数据损坏：报不变量违反（500），
      // 绝不用「重新开通一次」把它掩盖成一次新的远端写入。
      throw new Error("项目开通操作已成功，但项目行缺失（账本与项目表不一致）");
    }
    return project;
  }

  /** 把上游确定失败写成终态再抛出；同键重放会还原同一个错误，不再触碰远端。 */
  async function recordDefiniteFailure(operationId: string, step: string, error: AppError): Promise<never> {
    await operations.fail({ operationId, step, result: toOperationFailureResult(error) });
    throw error;
  }

  /** 上游失败的对外映射：同一批 Git 错误码在开通路径上都指向「这次开通没成」。 */
  function toProvisionError(failure: Extract<GitFailureKind, { kind: "definite" }>): AppError {
    switch (failure.code) {
      case "NOT_FOUND":
        return new NotFoundError("连接下的仓库不存在，或当前凭据无权访问该仓库");
      case "FORBIDDEN":
        return new ForbiddenError("当前凭据无权访问该仓库");
      case "CONFLICT":
        // §6.2：同名仓库已存在但无法确认归属时**不得**直接接管，唯一安全出路是显式绑定。
        return new RepositoryConflictError();
      case "RATE_LIMITED":
        return new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
      default:
        return new GitUnavailableError("托管平台不可用，请稍后重试");
    }
  }

  /** 建仓分支：建私有仓库 → 回读校验 owner（D1）→ 开启 Issues（幂等，缺失会让工单能力不可用）。 */
  async function createPrivateRepository(input: TicketProjectProvisionInput): Promise<GitRepository> {
    const name = input.repository.name ?? reservedRepositoryName(input.organizationId);
    const created = await git.admin.createPrivateRepository(input.connectionId, {
      owner: input.repository.owner,
      name,
      description: null,
    });
    if (created.ref.owner !== input.repository.owner) {
      // 请求里的 owner 不是授权依据，只是声明；不一致立刻失败且**不写绑定**，避免把别人的命名空间接管进来。
      throw new RepositoryOwnerMismatchError();
    }
    return git.admin.ensureIssuesEnabled(input.connectionId, {
      providerRepositoryId: created.ref.providerRepositoryId,
      owner: created.ref.owner,
      name: created.ref.name,
    });
  }

  /**
   * 解析并注册仓库绑定：`create` 走建仓，`bind` 只按 owner/name 回源解析。
   *
   * `bind` 分支显式传空的 `providerRepositoryId`：适配器的仓库读取路径只用 owner/name 寻址（`repoBase`），
   * 请求体自报的外部数字 ID 因此不会被采信——坐标一律以上游响应为准（§6.1）。
   */
  async function resolveBinding(input: TicketProjectProvisionInput): Promise<GitRepositoryBindingView> {
    const repository =
      input.mode === "create"
        ? await createPrivateRepository(input)
        : await git.admin.getRepository(input.connectionId, {
            providerRepositoryId: "",
            owner: input.repository.owner,
            name: requireBindName(input),
          });
    return git.admin.bindExistingRepository({
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      providerRepositoryId: repository.ref.providerRepositoryId,
      owner: repository.ref.owner,
      name: repository.ref.name,
      credentialRef: TICKET_CREDENTIAL_REF,
      allowedConsumers: TICKET_CONSUMER_GRANTS,
    });
  }

  /** `bind` 模式的名字必填由路由 schema 保证；服务端复检是为了让直接调用本服务的路径也拿不到空坐标。 */
  function requireBindName(input: TicketProjectProvisionInput): string {
    const name = input.repository.name;
    if (name === undefined || name.length === 0) {
      throw new ValidationError("mode=bind 必须提供仓库名");
    }
    return name;
  }

  return {
    async listReadable(access) {
      const page = await projects.listReadable({ access });
      return page.items;
    },

    async findReadable(input) {
      return projects.findReadableById({ access: input.access, projectId: input.projectId });
    },

    async provision(input) {
      // 连接必须来自 Git 配置：接受任意字符串会把「连接不存在」变成上游 404，用户看到的却是「仓库不存在」。
      if (!git.connectionIds.includes(input.connectionId)) {
        throw new ValidationError(`connectionId 不在当前 Git 配置中：${input.connectionId}`);
      }

      const repository =
        input.mode === "bind"
          ? { owner: input.repository.owner, name: requireBindName(input) }
          : {
              owner: input.repository.owner,
              ...(input.repository.name === undefined ? {} : { name: input.repository.name }),
            };
      const admission = await operations.begin({
        organizationId: input.organizationId,
        actorId: input.actorId,
        kind: "project.provision",
        projectId: null,
        idempotencyKey: input.idempotencyKey,
        requestHash: hashTicketRequest({
          kind: "project.provision",
          targetPath: projectProvisionTargetPath(),
          payload: { connectionId: input.connectionId, mode: input.mode, repository },
        }),
        // 开通没有正文，因此没有 message_id：远端对象是仓库本身，回源核对靠预留仓库名（§6.2）。
        messageId: null,
        expectedVersion: null,
        intent: { connectionId: input.connectionId, mode: input.mode, repository },
        step: TICKET_OPERATION_STEP.dispatching,
      });

      if (admission.kind === "failed") throw appErrorFromOperationResult(admission.result);
      if (admission.kind === "in_flight") return { kind: "uncertain", operationId: admission.operationId };
      if (admission.kind === "replayed") {
        // 重放：项目行已与成功终态同事务落库，直接读回即可，不再触碰远端。
        return {
          kind: "ok",
          project: await findProjectForReplay(admission.result),
          operationId: admission.operationId,
        };
      }

      const operationId = admission.operationId;
      let binding: GitRepositoryBindingView;
      try {
        binding = await resolveBinding(input);
      } catch (error) {
        // 上游结果未定 → 202；确定失败 → 写终态并抛出；其余异常保持 dispatching 上抛（见文件头）。
        const failure = classifyGitFailure(error);
        if (failure === undefined) {
          if (error instanceof RepositoryOwnerMismatchError) {
            return await recordDefiniteFailure(operationId, TICKET_OPERATION_STEP.ownerMismatch, error);
          }
          throw error;
        }
        if (failure.kind === "uncertain") {
          await operations.markUncertain({ operationId, step: TICKET_OPERATION_STEP.dispatching });
          return { kind: "uncertain", operationId };
        }
        return await recordDefiniteFailure(
          operationId,
          TICKET_OPERATION_STEP.upstreamFailed,
          toProvisionError(failure),
        );
      }

      const project = await withTicketLock(ticketsProjectLockKey(input.organizationId), async () => {
        const written = await projects.upsertByBinding({
          organizationId: input.organizationId,
          bindingId: binding.id,
          connectionId: binding.connectionId,
          providerRepositoryId: binding.repository.providerRepositoryId,
          owner: binding.repository.owner,
          name: binding.repository.name,
          createdBy: input.actorId,
        });
        // 归属列在冲突更新里被钉在原值上（仓储注释），冲突窗口内被别的组织抢先时在这里拒绝，
        // 而不是把一行不属于当前组织的项目当成功返回。
        if (written.organizationId !== input.organizationId) {
          throw new RepositoryConflictError("该仓库绑定已归属其他组织");
        }
        // 暂停中的项目重复开通不得被悄悄恢复成默认：运维决定（默认与启停）不由一次开通覆盖。
        if (written.status === "active") {
          await projects.setDefault({ organizationId: input.organizationId, projectId: written.id });
        }
        await operations.succeed({
          operationId,
          step: TICKET_OPERATION_STEP.projectReady,
          targetId: written.id,
          result: { projectId: written.id, bindingId: binding.id },
          // 开通的 intent 里没有用户正文，摘要只留判别模式，避免把连接坐标长期留在账本里。
          intentSummary: { mode: input.mode },
        });
        return written;
      });

      return { kind: "ok", project, operationId };
    },

    async setDefault(input) {
      // 先清旧默认再置新默认的两条 UPDATE 必须整体串行：并发切换会留下两条或零条默认项目。
      await withTicketLock(ticketsProjectLockKey(input.organizationId), async () => {
        await projects.setDefault({ organizationId: input.organizationId, projectId: input.projectId });
        if (input.status !== undefined) {
          await projects.setStatus({
            organizationId: input.organizationId,
            projectId: input.projectId,
            status: input.status,
          });
        }
      });
    },

    async setStatus(input) {
      return projects.setStatus(input);
    },
  };
}
