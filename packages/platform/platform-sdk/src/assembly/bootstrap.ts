import type { EnvDefinition, ModuleCleanup, ModuleContribution, ModuleManifest } from "./module-manifest";
import { createModuleRegistry } from "./module-registry";
import type { AssemblyProfile } from "./profile";

/** bootstrap 完成后的静态装配结果。 */
export interface BootstrapResult {
  readonly profile: AssemblyProfile;
  readonly modules: readonly ModuleManifest[];
  readonly env: Readonly<Record<string, unknown>>;
  readonly instances: ReadonlyMap<string, unknown>;
  readonly webContributions: ReadonlyMap<string, unknown>;
  /** 按资源获取的逆序幂等释放所有模块与贡献资源。 */
  readonly dispose: () => Promise<void>;
}

/** 与宿主 env loader、route 框架和生命周期注册器衔接的装配输入。 */
export interface BootstrapModulesOptions {
  readonly profile: unknown;
  readonly manifests: readonly ModuleManifest[];
  readonly loadEnv: (
    definitions: readonly EnvDefinition[],
  ) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
  readonly preflight?: (input: {
    profile: AssemblyProfile;
    modules: readonly ModuleManifest[];
    env: Readonly<Record<string, unknown>>;
  }) => void | Promise<void>;
  readonly mountContribution?: (input: {
    contribution: ModuleContribution;
    manifest: ModuleManifest;
    instance: unknown;
    registerCleanup: (cleanup: ModuleCleanup) => void;
  }) => void | Promise<void>;
}

interface CleanupStack {
  readonly dispose: () => Promise<void>;
  readonly runWithRegistrar: <T>(
    operation: (registerCleanup: (cleanup: ModuleCleanup) => void) => Promise<T>,
  ) => Promise<T>;
}

function createCleanupStack(): CleanupStack {
  const cleanups: ModuleCleanup[] = [];
  let disposePromise: Promise<void> | undefined;

  async function disposeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "模块清理失败");
  }

  return {
    dispose() {
      disposePromise ??= disposeAll();
      return disposePromise;
    },
    async runWithRegistrar<T>(
      operation: (registerCleanup: (cleanup: ModuleCleanup) => void) => Promise<T>,
    ): Promise<T> {
      let acceptingCleanup = true;
      try {
        return await operation((cleanup) => {
          if (!acceptingCleanup) throw new Error("模块初始化完成后不能继续登记 cleanup");
          cleanups.push(cleanup);
        });
      } finally {
        acceptingCleanup = false;
      }
    },
  };
}

function selectModuleEnv(
  manifest: ModuleManifest,
  env: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries((manifest.envDefinitions ?? []).map((definition) => [definition.key, env[definition.key]])),
  );
}

/**
 * 执行静态 server 装配的固定阶段。
 *
 * profile 和 registry 校验发生在任何工厂或贡献执行前，失败不会留下部分启动状态。
 */
export async function bootstrapModules(options: BootstrapModulesOptions): Promise<BootstrapResult> {
  const resolved = createModuleRegistry(options.manifests).resolveProfile(options.profile);
  const envDefinitions = resolved.modules.flatMap((manifest) => manifest.envDefinitions ?? []);
  const env = Object.freeze(await options.loadEnv(envDefinitions));
  await options.preflight?.({ profile: resolved.profile, modules: resolved.modules, env });

  const instances = new Map<string, unknown>();
  const cleanupStack = createCleanupStack();
  try {
    for (const manifest of resolved.modules) {
      if (!manifest.create) continue;
      const instance = await cleanupStack.runWithRegistrar((registerCleanup) =>
        Promise.resolve(
          manifest.create?.({
            env: selectModuleEnv(manifest, env),
            modules: instances,
            registerCleanup,
          }),
        ),
      );
      if (manifest.kind !== "resource" && (instance === undefined || instance === null)) {
        throw new Error(`基础模块 ${manifest.id} 工厂未返回实例`);
      }
      instances.set(manifest.id, instance);
    }

    if (options.mountContribution) {
      for (const manifest of resolved.modules) {
        for (const contribution of manifest.contributions ?? []) {
          await cleanupStack.runWithRegistrar((registerCleanup) =>
            Promise.resolve(
              options.mountContribution?.({
                contribution,
                manifest,
                instance: instances.get(manifest.id),
                registerCleanup,
              }),
            ),
          );
        }
      }
    }
  } catch (error) {
    try {
      await cleanupStack.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "模块装配失败且清理未完全成功");
    }
    throw error;
  }

  return Object.freeze({
    profile: resolved.profile,
    modules: resolved.modules,
    env,
    instances,
    webContributions: resolved.webContributions,
    dispose: cleanupStack.dispose,
  });
}
