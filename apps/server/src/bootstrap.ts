import {
  type BootstrapModulesOptions,
  type BootstrapResult,
  bootstrapModules,
  type ModuleManifest,
} from "@fenix/platform-sdk";
import { generatedModuleManifests } from "../../generated/module-registry";
import { loadAssemblyProfile } from "./assembly-config";

/** server 装配宿主必须提供的 env、preflight 与贡献挂载边界。 */
export interface ServerAssemblyBootstrapOptions
  extends Pick<BootstrapModulesOptions, "loadEnv" | "mountContribution" | "preflight"> {
  readonly profile?: unknown;
  readonly profilePath?: string;
  readonly manifests?: readonly ModuleManifest[];
}

/**
 * Server 的静态模块装配入口。
 *
 * 当前旧服务尚未切换到该入口；后续平台和资源任务只需提供 manifest 与宿主 adapter，
 * 不得在此增加具体模块 ID 到实现的手写映射。
 */
export async function bootstrapServerAssembly(options: ServerAssemblyBootstrapOptions): Promise<BootstrapResult> {
  const profile = options.profile === undefined ? await loadAssemblyProfile(options.profilePath) : options.profile;
  return bootstrapModules({
    profile,
    manifests: options.manifests ?? generatedModuleManifests,
    loadEnv: options.loadEnv,
    preflight: options.preflight,
    mountContribution: options.mountContribution,
  });
}
