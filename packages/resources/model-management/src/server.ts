/**
 * Provider、Model 与模型网关的服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server` 是唯一消费者；路由一律以工厂形式导出，守卫与宿主侧适配器由宿主注入
 * （理由见 `./server/routes/dependencies`）。本入口不导出浏览器代码——浏览器能力经 `./web` 取得。
 */

export { PROVIDER_RESOURCE_TYPE, providerResource } from "./server/access/provider-resource";
export type {
  AuthorizedProvider,
  AuthorizedProviderDetail,
  AuthorizedProviderListItem,
  ModelRef,
  ProviderFacadeApi,
  ProviderFacadeDeps,
  ProviderModelWriteResult,
  ProviderRef,
  ProviderWriteOptions,
} from "./server/facades/provider-facade";
export { ProviderFacade } from "./server/facades/provider-facade";
export * from "./server/model-gateway";
export { createModelGatewayRuntime } from "./server/model-gateway/runtime";
export { createModelGatewayRuntimeCredentialResolver } from "./server/model-gateway/runtime-credential-resolver";
export type { ModelManagementModuleDeps, ModelManagementServerModule } from "./server/module";
export { createModelManagementServerModule } from "./server/module";
export {
  getModelManagementModule,
  installModelManagementModule,
  resetModelManagementModule,
} from "./server/module-runtime";
export * from "./server/ports/subject-verification";
export type {
  UserModelPreferencesPatch,
  UserModelPreferencesPort,
  UserModelPreferencesSnapshot,
  UserModelPreferencesSubject,
} from "./server/ports/user-model-preferences";
export * from "./server/repositories/model-gateway-credential";
export type { ModelRepository, ModelRow, ModelWriteData } from "./server/repositories/model-resource";
export { createModelRepository } from "./server/repositories/model-resource";
export type {
  ProviderQueryStorage,
  ProviderRepository,
  ProviderRow,
  ProviderWriteData,
  ScopedProviderRow,
} from "./server/repositories/provider-resource";
export { createProviderRepository, PROVIDER_LIST_ORDER } from "./server/repositories/provider-resource";
export { createApiModelsRoutes } from "./server/routes/api/models";
export { createApiSystemModelGatewayRoutes } from "./server/routes/api/system-model-gateway";
export type {
  ApiModelManagementRouteDependencies,
  SystemApiModelManagementRouteDependencies,
  WebConfigModelsRouteDependencies,
  WebConfigProvidersRouteDependencies,
  WebModelManagementRouteDependencies,
} from "./server/routes/dependencies";
export { createWebConfigModelsRoutes } from "./server/routes/web/config/models";
export { createWebConfigProvidersRoutes } from "./server/routes/web/config/providers";
export { createWebModelGatewayRoutes } from "./server/routes/web/model-gateway";
export * from "./server/schemas/api-model.schema";
export * from "./server/schemas/config.schema";
// Peri 任务详情 schema 随本包迁出宿主（见 README「边界残留」）：宿主路由
// `apps/server/src/routes/web/peri-task-details.ts` 经本入口取 schema。
export * from "./server/schemas/peri-task-details";
export * from "./server/services/model-write-data";
export type { ProviderService, ProviderServiceReadInput } from "./server/services/provider-service";
export { createProviderService, parseProviderResourceKey } from "./server/services/provider-service";
export * from "./services/peri-task-detail-service";
export * from "./services/peri-task-detail-store";
