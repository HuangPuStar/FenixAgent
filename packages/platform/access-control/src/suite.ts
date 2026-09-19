import type { AuthorizedResourceQuery, QueryStorageTypes, ResourceStorageBinding } from "@fenix/platform-sdk";
import type { AccessControlDatabase } from "./database";
import { ACCESS_CONTROL_PROVIDER, DefaultAccessControl } from "./index";
import { DrizzleAuthorizedResourceQuery } from "./query/drizzle-authorized-resource-query";
import { ColumnResourceScopeStore } from "./scope/column-resource-scope-store";

/**
 * CE 的授权装配单元：把资源绑定汇总成可用的授权能力。
 *
 * 三个出口共享同一份资源注册，是"只声明一次"的关键——资源模块交出 `ResourceRegistration` 后，
 * 范围读写（scopeStore）与查询下推（authorizedQuery）都由本函数按同一份绑定构造，不需要资源
 * 模块分别注册两次，也不会出现两处注册不一致。
 */
export interface DrizzleAccessControlSuite<TStorage extends QueryStorageTypes = QueryStorageTypes> {
  readonly accessControl: DefaultAccessControl;
  readonly scopeStore: ColumnResourceScopeStore;
  readonly authorizedQuery: AuthorizedResourceQuery<TStorage>;
}

export interface CreateDrizzleAccessControlOptions {
  readonly database: AccessControlDatabase;
  /** 全部受控资源的存储绑定；`apps/server` 从各资源包汇总后注入。 */
  readonly bindings: readonly ResourceStorageBinding[];
}

export function createDrizzleAccessControl<TStorage extends QueryStorageTypes = QueryStorageTypes>(
  options: CreateDrizzleAccessControlOptions,
): DrizzleAccessControlSuite<TStorage> {
  const scopeStore = new ColumnResourceScopeStore(options.database, options.bindings);
  return {
    accessControl: new DefaultAccessControl(scopeStore),
    scopeStore,
    authorizedQuery: new DrizzleAuthorizedResourceQuery<TStorage>(
      options.database,
      ACCESS_CONTROL_PROVIDER,
      new Set(options.bindings.map((binding) => binding.resourceType)),
    ),
  };
}
