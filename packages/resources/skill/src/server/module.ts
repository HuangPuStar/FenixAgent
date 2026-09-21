import {
  type AccessControlModule,
  type AuthorizedResourceQuery,
  type IdentityDirectory,
  narrowAuthorizedQuery,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { skillResource } from "./access/skill-resource";
import type { SkillFacadeApi } from "./facades/skill-facade";
import { SkillFacade } from "./facades/skill-facade";
import { createSkillRepository, type SkillQueryStorage } from "./repositories/skill";
import { createSkillService, type SkillService } from "./services/skill-service";
import { createSkillSystem, type SkillSystemApi } from "./services/skill-system";

/**
 * Skill 资源包组合根。
 *
 * 依赖全部由注入方提供：授权能力来自 `@fenix/access-control`（`createDrizzleAccessControl` 的
 * `accessControl` / `scopeStore` / `authorizedQuery`），身份展示信息来自 `@fenix/identity` 的
 * `IdentityDirectory` 实现。本包不 import 任何具体实现，也不在模块内部保存进程级单例——一次装配
 * 产出一个实例集，测试可以装配自己的实例而互不影响。
 *
 * 注入方有两种，共用本函数这一处构造：registry 工厂（`src/module.ts` 的 `createSkillModule`，授权端口
 * 取自 `context.modules` 的 access-control 实例、身份目录取自 `@fenix/platform-sdk/server`）与测试
 * （直接注入替身）。本函数只构造，不读 DB、不写单例，因此两条路径不会互相覆盖。
 */

export interface SkillModuleDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** access-control 汇总全部资源模块声明的绑定后产出的查询端口；存储类型在本包内收窄。 */
  readonly authorizedQuery: AuthorizedResourceQuery;
  /** 组织名录等展示信息的只读投影；不由本包实现。 */
  readonly identity: IdentityDirectory;
}

export interface SkillServerModule {
  /** 资源注册；manifest 经它声明 `accessControlBindings`，避免两处各写一份归属列。 */
  readonly resource: typeof skillResource;
  /** 协议层入口（授权 + 领域编排 + 内容补偿写入）。 */
  readonly facade: SkillFacadeApi;
  /**
   * 领域服务（无授权判断）。
   *
   * 只有系统路径可直接调用它；对外路由必须走 `facade`，否则会绕过授权。
   */
  readonly service: SkillService;
  /**
   * 系统托管路径（builtin 同步与孤儿清理）。
   *
   * 与 `service` 分列是刻意的：`service` 是领域能力，`system` 是"谁在什么授权前提下调用它"的显式声明。
   * 调用方写出 `system.` 前缀时，评审者立刻知道这条路径不受授权谓词保护。
   */
  readonly system: SkillSystemApi;
  readonly identity: IdentityDirectory;
}

export function createSkillServerModule(deps: SkillModuleDeps): SkillServerModule {
  const query = narrowAuthorizedQuery<SkillQueryStorage>(deps.authorizedQuery);
  const service = createSkillService(createSkillRepository(query));
  return {
    resource: skillResource,
    facade: new SkillFacade(service, {
      accessControl: deps.accessControl,
      resource: skillResource.definition,
      scopeStore: deps.scopeStore,
    }),
    service,
    system: createSkillSystem(service),
    identity: deps.identity,
  };
}
