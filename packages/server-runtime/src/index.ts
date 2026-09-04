/** `@fenix/server-runtime` 的受控公开导出面。 */

export type {
  ApplicationBuilderOptions,
  ApplicationProfile,
} from "./application-builder";
export {
  ApplicationBuilder,
  ApplicationProfileError,
} from "./application-builder";
export type {
  ApplicationRuntimeState,
  ModuleDisposalFailure,
} from "./application-runtime";
export {
  ApplicationRuntime,
  ApplicationStartError,
  ApplicationStopError,
} from "./application-runtime";
export type {
  AnyServerModule,
  ModuleDisposer,
  ModuleStartContext,
  ServerModule,
} from "./server-module";
