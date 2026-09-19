/** Provider、Model 与模型网关的服务端公开入口。 */

export { default as apiModelsRoutes } from "./routes/api/models";
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
export { default as apiSystemModelGatewayRoutes } from "./server/routes/api/system-model-gateway";
export { default as webConfigModelsRoutes } from "./server/routes/web/config/models";
export { default as webConfigProvidersRoutes } from "./server/routes/web/config/providers";
export { default as webModelGatewayRoutes } from "./server/routes/web/model-gateway";
export * from "./server/services/model-write-data";
export type { ProviderService, ProviderServiceReadInput } from "./server/services/provider-service";
export { createProviderService, parseProviderResourceKey } from "./server/services/provider-service";
export * from "./services/peri-task-detail-service";
export * from "./services/peri-task-detail-store";
