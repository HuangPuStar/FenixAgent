import type { ActorContext, IdentityDirectory, SystemTenant } from "@fenix/platform-sdk";
import { AuthorizedResourceFacade, type AuthorizedResourceFacadeOptions, NotFoundError } from "@fenix/platform-sdk";
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
import type { PluginPackageService } from "../services/plugin-package-service";

/**
 * 市场目录的资源应用 Facade：授权编排 + 发布状态分派 + registry 读取编排。
 *
 * 它是 `/web/config/plugin-market/*` 与 `/api/system/plugin-market/*` 的**唯一**应用入口
 * （`route → Facade → Domain Service → Repository`）：route 只做协议接入与响应映射，领域服务不认识 actor。
 *
 * 两条面对应**两类凭据**，各有自己的入口方法，共用同一份领域编排：
 *
 * 1. **浏览面**（`/web/config/plugin-market/*`，会话 / API Key 认证）：任意已认证主体。读口径恒为公开面
 *    （`scope = "public"`），授权谓词由 `AccessControlModule` 产出后原样下推（`listConstraint`）。浏览面没有
 *    任何写入口：发布、下架与恢复是平台管理动作（`/admin` 的插件市场页）。
 * 2. **管理面**（`/api/system/plugin-market/*`，宿主系统 API Key）：平台运维者。宿主 `systemApiAuthPlugin`
 *    在进路由前完成校验，并**刻意不恢复用户 / 组织上下文**（`apps/server/src/plugins/system-api-auth.ts`：
 *    「避免与现有多租户 API 身份模型混淆」），因此管理面方法**不接收 actor**——没有可信主体可用。
 *
 * 管理面为什么不是「授权旁路」，而是同一份授权语义的另一半：市场条目的归属组织是**部署期事实**（身份表里
 * `slug = 'admin'` 的系统托管租户，`access/plugin-package-resource.ts` 的文件头解释了这条），不是任何请求
 * 主体解出来的。基于 actor 的写权探测（`resolveInitialScope`）回答的问题是「**这个用户**能否在系统租户下
 * 写」，而管理面的调用方不是用户——它拿的是平台根凭据，与 observer 的 `/api/system/logs`、sandbox 的
 * `/api/system/sandbox-pools` 同一类：**凭据本身就是判据**，判据在路由守卫（`systemApiKeyAuth: true`）。
 * Facade 因此在管理面上只解析归属与审计主体，不做第二遍角色判定——两处各判一次正是「按钮按旧规则显示、
 * 写入按新规则拒绝」这类漂移的来源。
 *
 * 管理面的审计主体取系统托管租户的 `userId`（`SystemTenant` 的说明：系统托管资源的 `user_id` 必须写真实
 * 用户 ID，不得伪造 actor），因此管理面不产生「匿名写入」；`requestId` 仍由宿主 `derive` 透传进审计流水。
 *
 * 浏览面的 `visibility` 恒为 `public`（主表默认值即市场语义），读口径因此只剩「是否含整包下架的条目」这一维。
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
 * 管理面写入的归属与审计主体。
 *
 * 两者都来自系统托管租户（{@link PluginPackageFacade.resolveWriterScope}）：`scope` 是创建期归属列，
 * `operatorUserId` 是审计流水与 `owner_user_id` 的取值。分开两个字段而不是合成一个，是因为它们的消费方
 * 不同——归属只进创建命令，审计主体在幂等与恢复分支上也要写。
 */
interface CatalogWriter {
  readonly scope: CatalogCreationScope;
  readonly operatorUserId: string;
}

/**
 * 市场的应用接口（Facade 的契约面）。
 *
 * 路由与测试只依赖本接口：测试因此可以提供实现而不构造真类（见 `../__tests__/market-fixtures.ts`），
 * 这也是路由用例能覆盖协议映射而完全不碰数据库的原因。
 *
 * 方法按**凭据族**分组（文件头的两类面）：`list` / `getDetail` 收 `ActorContext`，`listAll` / `getDetailAll`
 * 与四个写方法不收。混用是编译期错误，而不是运行期靠约定——浏览面拿不到管理面的读口径，管理面也拿不到
 * 浏览面的授权谓词。
 */
export interface PluginPackageFacadeApi {
  /**
   * 浏览面列表：公开口径 + 授权谓词下推。
   *
   * 不做服务端分页与检索（决策 D7）：市场规模由私有源决定且远小于其它目录页，前端过滤已经够用。
   */
  list(actor: ActorContext): Promise<{ items: PackageView[]; total: number }>;
  /** 浏览面详情；不存在、slug 非法或整包下架时抛 404（与「不存在」同响应）。 */
  getDetail(actor: ActorContext, slug: string): Promise<PackageDetailView>;
  /**
   * 管理面列表：**全量口径**（含整包下架的条目），不带逐行动作。
   *
   * 为什么不带 `access`：那是「当前主体对这个资源的有效动作」，而管理面的请求里没有主体（文件头）。管理页
   * 因此不按条目判断能力——它整个页面就是管理面，能进来就能写。
   */
  listAll(): Promise<{ items: PackageView[]; total: number }>;
  /** 管理面详情：含已下架版本并带 `unpublishedAt` 水印。 */
  getDetailAll(slug: string): Promise<PackageDetailView>;
  /** 读取私有源并产出规范化快照；**不写库**。 */
  preview(input: { packageName: string; exactVersion: string }): Promise<PublicationPreview>;
  /** 按库内状态分派：可见 → 幂等、已下架 → 恢复、不存在 → 回源读取并比对摘要。 */
  publish(input: PublishRequest): Promise<PublicationChange>;
  unpublish(input: CatalogWriteRequest): Promise<PublicationChange>;
  /** 恢复一个已下架的版本；版本不在市场里时报 404，且**不访问私有源**。 */
  restore(input: CatalogWriteRequest): Promise<PublicationChange>;
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

  /**
   * 浏览面列表：授权谓词与业务条件都下推到 SQL，列表与计数共用同一可见集合。
   *
   * 逐行**不附**有效动作（`withAccessMany` 的产物）：浏览面没有任何写入口（用户看得到市场，管理在 `/admin`），
   * 附上动作集合等于给前端一个没有消费方的能力位——它只会被用来渲染与真实判据无关的按钮。授权本身不受影响：
   * `listConstraint` 已经把谓词编译进这条 SQL，越权可见性在数据库层面就被排除。
   */
  async list(actor: ActorContext): Promise<{ items: PackageView[]; total: number }> {
    const access = await this.listConstraint(actor, "read");
    return this.service.list({ access, sourceId: this.sourceId(), scope: "public" });
  }

  /** 浏览面详情：定位符是 slug（包名的 base64url 编码），解析失败与不可见同响应 404。 */
  async getDetail(actor: ActorContext, slug: string): Promise<PackageDetailView> {
    const access = await this.listConstraint(actor, "read");
    const detail = await this.service.findDetailBySlug({ access, sourceId: this.sourceId(), scope: "public", slug });
    // 不存在、slug 非法与「整包下架」在这里合流成同一个 404：区分它们会把市场变成一个探针
    // （「这个包存在但被下架了」是可被外部推知的内部状态）。
    if (!detail) throw new NotFoundError(`插件包 '${slug}' 不存在`);
    return detail;
  }

  /**
   * 管理面列表：全量口径、不带授权谓词。
   *
   * 无 `access` 是平台端口记录在案的例外形状（`AuthorizedResourceQuery` 的说明：「不传表示无权限的 Domain
   * Service 内部调用路径，例如系统管理 Facade 已完成超级管理员校验」）。这条例外**只能**由本方法使用：
   * route 不得直接调用无 `access` 的查询。
   */
  async listAll(): Promise<{ items: PackageView[]; total: number }> {
    return this.service.list({ sourceId: this.sourceId(), scope: "all" });
  }

  /** 管理面详情：全量口径；不存在或 slug 非法时抛 404。 */
  async getDetailAll(slug: string): Promise<PackageDetailView> {
    const detail = await this.service.findDetailBySlug({ sourceId: this.sourceId(), scope: "all", slug });
    if (!detail) throw new NotFoundError(`插件包 '${slug}' 不存在`);
    return detail;
  }

  /** 预览：读私有源、规范化、算摘要；不写库。判据在路由守卫，见文件头。 */
  async preview(input: { packageName: string; exactVersion: string }): Promise<PublicationPreview> {
    return this.#registry.preview(this.toRef(input));
  }

  /**
   * 发布：按库内该精确版本的状态分派（决策「publish 的状态分派」）。
   *
   * 前置的这一次读**不加锁**（`getPublicationState` 的说明解释了为什么）：它只决定「要不要出网」。真正的
   * 判定在 `publish` 内部锁保护下重新做一遍，因此并发的两次确认不会各自读到空状态各插一行——分派结果以
   * 锁内读到的状态为准，这里读到的状态只影响走哪条路径。
   */
  async publish(input: PublishRequest): Promise<PublicationChange> {
    const writer = await this.resolveWriterScope();
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
          scope: writer.scope,
          operatorUserId: writer.operatorUserId,
          snapshot: stored,
        }),
      );
    }
    return this.#publishFromRegistry(ref, input, writer);
  }

  /** 下架某个精确版本；版本不在市场里时由领域抛 404（本层不预检，预检会让两处判定漂移）。 */
  async unpublish(input: CatalogWriteRequest): Promise<PublicationChange> {
    const writer = await this.resolveWriterScope();
    const ref = this.toRef(input);
    return this.#catalog.unpublish({
      sourceId: ref.sourceId,
      packageName: ref.packageName,
      exactVersion: ref.exactVersion,
      operatorUserId: writer.operatorUserId,
      requestId: input.requestId,
    });
  }

  /** 恢复；显式入口，与发布路径的区别只有「版本必须已在市场里」这一条。 */
  async restore(input: CatalogWriteRequest): Promise<PublicationChange> {
    const writer = await this.resolveWriterScope();
    const ref = this.toRef(input);
    const stored = (await this.#catalog.getPublicationState(ref, ref.exactVersion)).publication;
    if (stored === null) {
      throw new PluginMarketError("PUBLICATION_NOT_FOUND", "该版本从未进入市场，无法恢复；请改用发布");
    }
    return this.#catalog.publish(
      this.toPublishCommand({
        ref,
        requestId: input.requestId,
        scope: writer.scope,
        operatorUserId: writer.operatorUserId,
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
    ref: PackageVersionRef,
    input: PublishRequest,
    writer: CatalogWriter,
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
        scope: writer.scope,
        operatorUserId: writer.operatorUserId,
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
   * 管理面的每次写入都要拿它解析归属组织与审计主体（见 {@link resolveWriterScope}），而
   * `resolveSystemTenant()` 会查身份库、必要时还会执行一次系统管理员引导，把它放在每个发布请求上是不必要
   * 的开销。租户是**部署期事实**：引导完成后 admin 组织与系统用户的 ID 不再变化。
   *
   * 移除条件：身份模块若将来支持在进程存活期间重建系统租户，这个缓存必须改成可失效的（否则发布了新条目
   * 会落在一个已不存在的组织 ID 上，条目只对公开受众可见、管理面看不见）。
   */
  private systemTenant(): Promise<SystemTenant> {
    this.#tenant ??= this.#identity.resolveSystemTenant();
    return this.#tenant;
  }

  /**
   * 管理面写入的归属与审计主体。
   *
   * 归属组织**不从请求推导**：它就是市场条目的归属组织（系统托管租户，见文件头）。审计主体同样取租户的
   * `userId`——主表的 `owner_user_id` 是 NOT NULL 且必须是真实用户 ID（`SystemTenant` 的说明），因此管理面
   * 不会写出「匿名条目」。
   */
  private async resolveWriterScope(): Promise<CatalogWriter> {
    const tenant = await this.systemTenant();
    return {
      scope: { organizationId: tenant.organizationId, ownerUserId: tenant.userId },
      operatorUserId: tenant.userId,
    };
  }
}
