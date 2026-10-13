import {
  type BootstrapModulesOptions,
  type BootstrapResult,
  bootstrapModules,
  type ModuleManifest,
} from "@fenix/platform-sdk";
import { generatedModuleManifests } from "../../generated/module-registry";
import { loadAssemblyProfile } from "./assembly-config";
import { loadServerEnv } from "./env-loader";

/** server 装配宿主必须提供的 env、preflight 与贡献挂载边界。 */
export interface ServerAssemblyBootstrapOptions
  extends Pick<BootstrapModulesOptions, "mountContribution" | "preflight"> {
  readonly profile?: unknown;
  readonly profilePath?: string;
  readonly manifests?: readonly ModuleManifest[];
  readonly loadEnv?: BootstrapModulesOptions["loadEnv"];
}

/**
 * Server 的静态模块装配入口。
 *
 * 1.5f 起这是服务的**唯一**装配路径（`bootstrap/host-startup.ts` 的关键启动序列里调用）。新增平台和资源
 * 模块只需提供 manifest 与宿主 adapter，**不得在此增加具体模块 ID 到实现的手写映射**——那样会把
 * 「哪些模块被装配」的真相源从 assembly profile 挪回宿主代码。
 */
export async function bootstrapServerAssembly(options: ServerAssemblyBootstrapOptions): Promise<BootstrapResult> {
  const profile = options.profile === undefined ? await loadAssemblyProfile(options.profilePath) : options.profile;
  return bootstrapModules({
    profile,
    manifests: options.manifests ?? generatedModuleManifests,
    loadEnv: options.loadEnv ?? loadServerEnv,
    preflight: options.preflight,
    mountContribution: options.mountContribution,
  });
}
