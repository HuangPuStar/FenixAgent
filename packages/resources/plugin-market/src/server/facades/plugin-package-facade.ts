import type { ActorContext, AuthorizedResource, IdentityDirectory, SystemTenant } from "@fenix/platform-sdk";
import {
  AuthorizedResourceFacade,
  type AuthorizedResourceFacadeOptions,
  ForbiddenError,
  NotFoundError,
  ResourceAccessDeniedError,
} from "@fenix/platform-sdk";
import { getPluginMarketConfig } from "../config";
import type { PackageDetailView, PackageView } from "../domain/package-view";
import type {
  CatalogCreationScope,
  PublicationChange,
  PublicationState,
  PublishCommand,
  UnpublishCommand,
} from "../domain/types";
import { PluginMarketError } from "../errors";
import { assertExactVersion, assertPackageName } from "../npm-registry/normalize";
import { getPluginRegistryClient } from "../npm-registry/service";
import type { PackageVersionRef, PublicationPreview } from "../npm-registry/types";
import type { PackageIdentity } from "../repositories/plugin-package";
import { getPublicationState, publishVersion, unpublishVersion } from "../services/plugin-catalog-service";
import type { CatalogReadScope, PluginPackageService } from "../services/plugin-package-service";

/**
 * 市场目录的资源应用 Facade：授权编排 + 发布状态分派 + registry 读取编排。
 *
 * 它是 `/web/config/plugin-market/*` 的唯一应用入口（`route → Facade → Domain Service → Repository`）：
 * route 只做协议接入与响应映射，领域服务不认识 actor。所有授权判断都经 `AccessControlModule`（继承基类的
 * `resolveInitialScope` / `listConstraint` / `withAccessMany`），本文件**不复制**任何组织、角色或
 * `visibility` 规则。
 *
 * 两条与权限有关的领域事实落在这里，而不是路由或服务里：
 *
 * 1. **写权 = 系统托管租户的 owner / admin**。市场条目的归属组织固定为系统托管租户
 *    （`access/plugin-package-resource.ts` 的文件头解释了这条），因此「能否发布」等价于「能否在系统租户下
 *    创建这个资源」。探测走 `resolveInitialScope`（与真正的写入路径同源），不自己读角色。
 * 2. **读口径由写权推出**（见 {@link resolveReadScope}）：写权主体看得到整包下架的条目，其余人只看公开面。
 *
 * 网络读取（npm 私有源）只发生在两条路径上：`preview` 与「确认发布但库内没有该版本」。恢复与幂等分支
 * **永不出网**——它们复用市场内的冻结快照，这也正是「快照发布后不可变」在读取侧的体现。
 */

/**
 * 「预览的内容已变化」。
 *
 * 单独一个错误类（而不是带 `details` 的通用 {PluginMarketError}）是为了让协议层**类型安全**地取回新快照：
 * 409 的响应体必须携带它（前端据此在原位重新确认，见 `docs/design` 的发布流程），而 `details` 是形状为
 * `Record<string, unknown>` 的袋子，路由从里面取值只能靠断言。
 */
export class PreviewChangedError extends PluginMarketError {
  readonly preview: PublicationPreview;

  constructor(preview: PublicationPreview) {
    super("PREVIEW_CHANGED", "该版本的内容在预览之后已变化，请确认新的快照", { preview });
    this.preview = preview;
  }
}

/**
 * 目录写原语。
 *
 * 存在的原因是**测试进程里没有 Postgres**：发布分派（可见 → 幂等、已下架 → 恢复、不存在 → 回源读私有源并
 * 比对摘要）是本模块最容易写错的一段逻辑，而它只有连着库才能跑到。把三个入口收成一个端口后，用例可以
 * 用 `__tests__/catalog-harness.ts` 的内存底座注入同形的实现，从而覆盖「分派是否正确」而不只是「有没有
 * 调过某个函数」。
 *
 * 生产实现是 `../services/plugin-catalog-service` 的同名函数直通；端口不复制它们的任何语义。
 */
export interface PluginCatalogPort {
  getPublicationState(identity: PackageIdentity, exactVersion: string): Promise<PublicationState>;
  publish(command: PublishCommand): Promise<PublicationChange>;
  unpublish(command: UnpublishCommand): Promise<PublicationChange>;
}

const defaultCatalogPort: PluginCatalogPort = {
  getPublicationState: (identity, exactVersion) => getPublicationState(identity, exactVersion),
  publish: (command) => publishVersion(command),
  unpublish: (command) => unpublishVersion(command),
};

/**
 * 私有源读取原语。只有一个方法，因为市场只做一件事：读某个精确版本的元数据。
 *
 * 与 {@link PluginCatalogPort} 同因（测试进程里没有 Postgres），但多一条：本仓库的 `bun test` 把所有测试文件
 * 放进同一个进程，而**别的测试文件会替换 `globalThis.fetch`**（`__tests__/fixtures.ts` 的文件头记录了实测
 * 结果）。若 Facade 直连进程全局传输，最该被逐条钉住的那段逻辑——「哪些分支**永不出网**」「摘要不一致时写入
 * 被拦下」——就会随执行顺序时绿时红。端口把「出网」这件事变成可计数的调用。
 *
 * 生产实现是 `../npm-registry/service` 的客户端直通；端口不复制它的任何语义（凭据、超时、体积上限都在那里）。
 */
export interface PluginRegistryPort {
  preview(ref: PackageVersionRef): Promise<PublicationPreview>;
}

const defaultRegistryPort: PluginRegistryPort = {
  preview: (ref) => getPluginRegistryClient().preview(ref),
};

export interface PluginPackageFacadeOptions extends AuthorizedResourceFacadeOptions {
  /** 系统托管租户目录：归属组织由它解析，不由本包实现。 */
  readonly identity: IdentityDirectory;
  /** 目录写原语；缺省走生产实现（见 {@link PluginCatalogPort}）。 */
  readonly catalog?: PluginCatalogPort;
  /** 私有源读取原语；缺省走生产实现（见 {@link PluginRegistryPort}）。 */
  readonly registry?: PluginRegistryPort;
}

/** 一次发布/下架请求的公共入参；`requestId` 只进审计流水。 */
export interface CatalogWriteRequest {
  readonly packageName: string;
  readonly exactVersion: string;
  readonly requestId: string | null;
}

/** 确认发布的入参：`previewDigest` 是预览结果里的摘要，服务端在写入前重新读取私有源并比对。 */
export interface PublishRequest extends CatalogWriteRequest {
  readonly previewDigest?: string;
}

/**
 * 市场的应用接口（Facade 的契约面）。
 *
 * 路由与测试只依赖本接口：测试因此可以提供实现而不构造真类（见 `../__tests__/market-fixtures.ts`），
 * 这也是路由用例能覆盖协议映射而完全不碰数据库的原因。
 */
export interface PluginPackageFacadeApi {
  /**
   * 列表。`canPublish` 是**页面级能力位**（不是逐条资源的动作）：市场是全局目录，写权只取决于主体是不是
   * 平台系统管理员，因此它由服务端在同一个写权探针上顺带给出。前端不给第二个判据——按列表条目推导在
   * 「市场还是空的」时会把管理员也判成只读，第一次发布就没有入口。
   */
  list(actor: ActorContext): Promise<{ items: AuthorizedResource<PackageView>[]; total: number; canPublish: boolean }>;
  /** 详情；不存在、slug 非法或按当前读口径不可见时抛 404。 */
  getDetail(actor: ActorContext, slug: string): Promise<AuthorizedResource<PackageDetailView>>;
  /** 读取私有源并产出规范化快照；**不写库**。 */
  preview(actor: ActorContext, input: { packageName: string; exactVersion: string }): Promise<PublicationPreview>;
  /** 按库内状态分派：可见 → 幂等、已下架 → 恢复、不存在 → 回源读取并比对摘要。 */
  publish(actor: ActorContext, input: PublishRequest): Promise<PublicationChange>;
  unpublish(actor: ActorContext, input: CatalogWriteRequest): Promise<PublicationChange>;
  /** 恢复一个已下架的版本；版本不在市场里时报 404，且**不访问私有源**。 */
  restore(actor: ActorContext, input: CatalogWriteRequest): Promise<PublicationChange>;
}

export class PluginPackageFacade extends AuthorizedResourceFacade implements PluginPackageFacadeApi {
  readonly #identity: IdentityDirectory;
  readonly #catalog: PluginCatalogPort;
  readonly #registry: PluginRegistryPort;
  /** 系统托管租户的进程内缓存；见 {@link systemTenant}。 */
  #tenant: Promise<SystemTenant> | null = null;

  constructor(
    private readonly service: PluginPackageService,
    options: PluginPackageFacadeOptions,
  ) {
    super(options);
    this.#identity = options.identity;
    this.#catalog = options.catalog ?? defaultCatalogPort;
    this.#registry = options.registry ?? defaultRegistryPort;
  }

  /** 列表：授权谓词与业务条件都下推到 SQL，列表与计数共用同一可见集合。 */
  async list(
    actor: ActorContext,
  ): Promise<{ items: AuthorizedResource<PackageView>[]; total: number; canPublish: boolean }> {
    const [access, scope] = await Promise.all([this.listConstraint(actor, "read"), this.resolveReadScope(actor)]);
    const { items, total } = await this.service.list({ access, sourceId: this.sourceId(), scope });
    const authorized = await this.withAccessMany(actor, items);
    // 读口径由写权推出（见 `resolveReadScope`），反向取用即得页面级能力位：不需要第二次授权判定，
    // 也不会出现「按钮按十年前的规则显示、写入按现行规则拒绝」这类两处判定漂移。
    return { items: authorized, total, canPublish: scope === "all" };
  }

  /** 详情：定位符是 slug（包名的 base64url 编码），解析失败与不可见同响应 404。 */
  async getDetail(actor: ActorContext, slug: string): Promise<AuthorizedResource<PackageDetailView>> {
    const [access, scope] = await Promise.all([this.listConstraint(actor, "read"), this.resolveReadScope(actor)]);
    const detail = await this.service.findDetailBySlug({ access, sourceId: this.sourceId(), scope, slug });
    // 不存在、slug 非法与「整包下架且主体无写权」在这里合流成同一个 404：区分它们会把市场变成一个
    // 探针（「这个包存在但被下架了」是可被外部推知的内部状态）。
    if (!detail) throw new NotFoundError(`插件包 '${slug}' 不存在`);
    return this.withAccess(actor, detail);
  }

  /** 预览：读私有源、规范化、算摘要；不写库。写权校验在最前，未授权的主体连私有源都不该被代为读取。 */
  async preview(
    actor: ActorContext,
    input: { packageName: string; exactVersion: string },
  ): Promise<PublicationPreview> {
    await this.requirePublishScope(actor);
    return this.#registry.preview(this.toRef(input));
  }

  /**
   * 发布：按库内该精确版本的状态分派（决策「publish 的状态分派」）。
   *
   * 前置的这一次读**不加锁**（`getPublicationState` 的说明解释了为什么）：它只决定「要不要出网」。真正的
   * 判定在 `publish` 内部锁保护下重新做一遍，因此并发的两次确认不会各自读到空状态各插一行——分派结果以
   * 锁内读到的状态为准，这里读到的状态只影响走哪条路径。
   */
  async publish(actor: ActorContext, input: PublishRequest): Promise<PublicationChange> {
    const scope = await this.requirePublishScope(actor);
    const ref = this.toRef(input);
    const stored = (await this.#catalog.getPublicationState(ref, ref.exactVersion)).publication;

    if (stored !== null) {
      // 可见 → 幂等；已下架 → 恢复。两者都用**市场内的冻结快照**，因此都不出网、也不比对摘要：
      // 恢复的语义是「把市场里那一份重新对公众可见」，与私有源此刻的内容无关——在私有源允许覆盖已发布
      // 版本的部署里，比对摘要只会拒掉一次合法恢复（用户也没有第二条路可走：同版本不能二次发布）。
      return this.#catalog.publish(
        this.toPublishCommand({
          ref,
          requestId: input.requestId,
          scope,
          operatorUserId: actor.userId,
          snapshot: stored,
        }),
      );
    }
    return this.#publishFromRegistry(actor, ref, input, scope);
  }

  /** 下架某个精确版本；版本不在市场里时由领域抛 404（本层不预检，预检会让两处判定漂移）。 */
  async unpublish(actor: ActorContext, input: CatalogWriteRequest): Promise<PublicationChange> {
    await this.requirePublishScope(actor);
    const ref = this.toRef(input);
    return this.#catalog.unpublish({
      sourceId: ref.sourceId,
      packageName: ref.packageName,
      exactVersion: ref.exactVersion,
      operatorUserId: actor.userId,
      requestId: input.requestId,
    });
  }

  /** 恢复；显式入口，与发布路径的区别只有「版本必须已在市场里」这一条。 */
  async restore(actor: ActorContext, input: CatalogWriteRequest): Promise<PublicationChange> {
    const scope = await this.requirePublishScope(actor);
    const ref = this.toRef(input);
    const stored = (await this.#catalog.getPublicationState(ref, ref.exactVersion)).publication;
    if (stored === null) {
      throw new PluginMarketError("PUBLICATION_NOT_FOUND", "该版本从未进入市场，无法恢复；请改用发布");
    }
    return this.#catalog.publish(
      this.toPublishCommand({
        ref,
        requestId: input.requestId,
        scope,
        operatorUserId: actor.userId,
        snapshot: stored,
      }),
    );
  }

  /**
   * 「不存在」分支：回源读取 + 摘要比对后才落库。
   *
   * 摘要比对是**确认步骤的全部意义**：预览与确认之间私有源上的内容可能已被替换（私有源允许覆盖已发布
   * 版本，或包被重新推送），若直接落库，用户确认的是 A、市场里存下的却是 B。不一致时抛
   * {@link PreviewChangedError}，把新读到的快照一并交回前端原地重新确认。
   */
  async #publishFromRegistry(
    actor: ActorContext,
    ref: PackageVersionRef,
    input: PublishRequest,
    scope: CatalogCreationScope,
  ): Promise<PublicationChange> {
    if (input.previewDigest === undefined || input.previewDigest.length === 0) {
      throw new PluginMarketError("INVALID_INPUT", "确认发布必须携带预览摘要（previewDigest）");
    }
    const preview = await this.#registry.preview(ref);
    if (preview.metadataDigest !== input.previewDigest) throw new PreviewChangedError(preview);
    return this.#catalog.publish(
      this.toPublishCommand({
        ref,
        requestId: input.requestId,
        scope,
        operatorUserId: actor.userId,
        snapshot: preview,
      }),
    );
  }

  /** 组装发布命令；`snapshot` 决定写入哪一份快照（库内冻结的或刚从私有源读到的）。 */
  private toPublishCommand(input: {
    readonly ref: PackageVersionRef;
    readonly requestId: string | null;
    readonly scope: CatalogCreationScope;
    readonly operatorUserId: string;
    readonly snapshot: { readonly metadataJson: string; readonly metadataDigest: string };
  }): PublishCommand {
    return {
      sourceId: input.ref.sourceId,
      packageName: input.ref.packageName,
      exactVersion: input.ref.exactVersion,
      metadataJson: input.snapshot.metadataJson,
      metadataDigest: input.snapshot.metadataDigest,
      creationScope: input.scope,
      operatorUserId: input.operatorUserId,
      requestId: input.requestId,
    };
  }

  /** 解析并校验「精确版本引用」：来源固定为部署配置，包名与版本必须**在拼 URL 之前**过形状校验。 */
  private toRef(input: { packageName: string; exactVersion: string }): PackageVersionRef {
    return {
      sourceId: this.sourceId(),
      packageName: assertPackageName(input.packageName),
      exactVersion: assertExactVersion(input.exactVersion),
    };
  }

  /** 部署配置的来源标识；它是市场条目的稳定身份之一，只由配置决定，绝不接受请求传入。 */
  private sourceId(): string {
    return getPluginMarketConfig().sourceId;
  }

  /**
   * 系统托管租户，进程内缓存一次。
   *
   * 读路径每次都要问「这个主体有写权吗」（读口径由它决定），而 `resolveSystemTenant()` 会查身份库、必要时
   * 还会执行一次系统管理员引导，把它放在每个列表请求上是不必要的开销。租户是**部署期事实**：引导完成后
   * admin 组织与系统用户的 ID 不再变化。
   *
   * 移除条件：身份模块若将来支持在进程存活期间重建系统租户，这个缓存必须改成可失效的（否则发布了新条目
   * 会落在一个已不存在的组织 ID 上，条目只对公开受众可见、管理面看不见）。
   */
  private systemTenant(): Promise<SystemTenant> {
    this.#tenant ??= this.#identity.resolveSystemTenant();
    return this.#tenant;
  }

  /**
   * 写权探测：通过则返回发布归属，未通过返回 `null`。
   *
   * 用 `resolveInitialScope`（创建期归属解析）**探针**而不是逐行 `authorize`：读口径必须在拿到任何行
   * **之前**确定，因为它要作为 SQL 条件下推（整包下架 = `latest_publication_id IS NULL`），而行级
   * `authorize` 需要先有一个 resourceId。这个探针与真正的写入路径判定同源——两者都走同一份策略
   * （`projectActions`），本资源的动作集又是全有或全无（owner/admin 拿全部动作，member 与公开受众只有
   * `read`），因此「能否在系统租户下创建」与「能否发布 / 下架」永远是同一个结论。
   *
   * 归属组织必须显式传系统租户：策略的组织分支要求资源归属组织**就是** actor 的 active organization，
   * 传别的组织会让所有人（包括真正的系统管理员）都被判为无写权。
   */
  private async resolvePublishScope(actor: ActorContext): Promise<CatalogCreationScope | null> {
    const tenant = await this.systemTenant();
    try {
      const scope = await this.resolveInitialScope(actor, tenant.organizationId);
      return {
        organizationId: scope.organizationId ?? tenant.organizationId,
        // 组织模式不记 owner（归属属于组织），但主表的 `owner_user_id` 是 NOT NULL：写操作人。
        ownerUserId: scope.ownerUserId ?? actor.userId,
      };
    } catch (error) {
      if (error instanceof ResourceAccessDeniedError) return null;
      throw error;
    }
  }

  /** 写路径的授权：探测未通过即 403；通过则返回发布归属（含写操作人，即本次请求的主体）。 */
  private async requirePublishScope(actor: ActorContext): Promise<CatalogCreationScope> {
    const scope = await this.resolvePublishScope(actor);
    if (scope === null) throw new ForbiddenError("只有平台系统管理员可以发布或下架插件");
    return scope;
  }

  /** 读口径：写权主体（平台系统管理员）看得到整包下架的条目，其余人只看公开面。 */
  private async resolveReadScope(actor: ActorContext): Promise<CatalogReadScope> {
    return (await this.resolvePublishScope(actor)) === null ? "public" : "all";
  }
}
