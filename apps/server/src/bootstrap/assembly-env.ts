import { type AssemblyProfile, createModuleRegistry, type ModuleManifest } from "@fenix/platform-sdk";
import { generatedModuleManifests } from "../../../generated/module-registry";
import { loadAssemblyProfile } from "../assembly-config";
import { loadServerEnv, type ServerEnv } from "../env-loader";

/** 装配期环境解析结果：已校验的 profile 与合并后的环境。 */
export interface ResolvedAssemblyEnv {
  readonly profile: AssemblyProfile;
  readonly env: ServerEnv;
}

/** 解析入口的装配输入；缺省走发布入口固定的 profile 与生成的模块清单。 */
export interface ResolveAssemblyEnvOptions {
  readonly profilePath?: string;
  readonly manifests?: readonly ModuleManifest[];
  /** 环境变量来源；缺省 `process.env`，测试可注入 fixture 而不改进程环境。 */
  readonly input?: Readonly<Record<string, unknown>>;
}

/**
 * 先解析 assembly profile，再按**已启用模块**汇总 env 声明并加载环境变量（§5.1）。
 *
 * 顺序不可颠倒：模块声明的键必须与宿主 schema 的字段汇入同一个 `env` 对象，宿主的
 * `config` / `buildModuleConfigs` 才读得到。此前 `main.ts` 用 `loadServerEnv([])`，模块声明只到
 * 模块工厂（`bootstrapModules` 内部的第二次 `loadEnv`），宿主侧永远看不到——本函数就是那条回流通道。
 *
 * 解析出的 `profile` 由调用方透传给 `bootstrapServerAssembly()`，装配层因此不再二次读文件。
 * `bootstrapModules` 内部仍会自行 `resolveProfile`，那是同一份 profile 的纯计算重放，无 IO。
 */
export async function resolveAssemblyEnv(options: ResolveAssemblyEnvOptions = {}): Promise<ResolvedAssemblyEnv> {
  const profile = await loadAssemblyProfile(options.profilePath);
  const { modules } = createModuleRegistry(options.manifests ?? generatedModuleManifests).resolveProfile(profile);
  const definitions = modules.flatMap((manifest) => manifest.envDefinitions ?? []);
  return { profile, env: loadServerEnv(definitions, options.input) };
}
