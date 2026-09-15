import type { ModuleKind, ModuleManifest } from "./module-manifest";
import type { AssemblyProfile } from "./profile";
import { isModuleId, parseAssemblyProfile } from "./profile";

/** 已校验并按装配依赖排序的 profile 解析结果。 */
export interface ResolvedAssembly {
  readonly profile: AssemblyProfile;
  readonly modules: readonly ModuleManifest[];
  readonly webContributions: ReadonlyMap<string, unknown>;
}

/** 仅查询构建期静态 manifest 的 registry。 */
export interface ModuleRegistry {
  resolveProfile(profile: unknown): ResolvedAssembly;
}

function assertStableId(id: string, label: string): void {
  if (!isModuleId(id)) throw new Error(`${label}不是合法模块 ID: ${id}`);
}

/**
 * 创建只读模块 registry。
 *
 * 此函数不扫描文件、不动态 import；它只校验生成器已经静态导入的 manifest 集合。
 */
export function createModuleRegistry(manifests: readonly ModuleManifest[]): ModuleRegistry {
  const byId = new Map<string, ModuleManifest>();
  const webById = new Map<string, ModuleManifest>();

  for (const manifest of manifests) {
    assertStableId(manifest.id, "模块 ID ");
    if (byId.has(manifest.id)) throw new Error(`模块 ID 重复: ${manifest.id}`);
    byId.set(manifest.id, manifest);

    const dependencies = new Set<string>();
    for (const dependencyId of manifest.dependsOn) {
      assertStableId(dependencyId, `模块 ${manifest.id} 的依赖 `);
      if (dependencyId === manifest.id) throw new Error(`模块 ${manifest.id} 不能依赖自身`);
      if (dependencies.has(dependencyId)) throw new Error(`模块 ${manifest.id} 重复声明依赖 ${dependencyId}`);
      dependencies.add(dependencyId);
    }

    for (const capability of manifest.capabilities ?? []) {
      assertStableId(capability.replaceAll(".", "-"), `模块 ${manifest.id} 的 capability `);
    }

    for (const definition of manifest.envDefinitions ?? []) {
      if (definition.moduleId !== manifest.id) {
        throw new Error(`环境变量 ${definition.key} 的 moduleId 必须是 ${manifest.id}`);
      }
    }

    if (manifest.web) {
      assertStableId(manifest.web.id, `模块 ${manifest.id} 的 Web ID `);
      if (webById.has(manifest.web.id)) throw new Error(`Web 模块 ID 重复: ${manifest.web.id}`);
      webById.set(manifest.web.id, manifest);
    }
  }

  for (const manifest of manifests) {
    for (const dependencyId of manifest.dependsOn) {
      if (!byId.has(dependencyId)) throw new Error(`模块 ${manifest.id} 依赖未注册模块 ${dependencyId}`);
    }
  }

  function requireModule(id: string, kind?: ModuleKind): ModuleManifest {
    const manifest = byId.get(id);
    if (!manifest) throw new Error(`装配配置引用了未注册模块: ${id}`);
    if (kind && manifest.kind !== kind) throw new Error(`模块 ${id} 必须是 ${kind}，实际为 ${manifest.kind}`);
    return manifest;
  }

  function requireFoundation(
    id: string,
    kind: Extract<ModuleKind, "access-control" | "agent-runtime">,
  ): ModuleManifest {
    const manifest = requireModule(id, kind);
    if (!manifest.create) throw new Error(`基础模块 ${id} 未提供创建工厂`);
    return manifest;
  }

  return Object.freeze({
    resolveProfile(profileInput: unknown): ResolvedAssembly {
      const profile = parseAssemblyProfile(profileInput);
      requireFoundation(profile.accessControl, "access-control");
      requireFoundation(profile.agentRuntime, "agent-runtime");
      for (const resourceId of profile.resources) requireModule(resourceId, "resource");

      const requestedIds = [profile.accessControl, profile.agentRuntime, ...profile.resources];
      const enabledIds = new Set(requestedIds);
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const sorted: ModuleManifest[] = [];

      function visit(id: string): void {
        if (visited.has(id)) return;
        if (visiting.has(id)) throw new Error(`模块装配依赖存在循环: ${id}`);
        visiting.add(id);
        const manifest = requireModule(id);
        for (const dependencyId of manifest.dependsOn) {
          if (!enabledIds.has(dependencyId)) throw new Error(`模块 ${id} 依赖未启用模块 ${dependencyId}`);
          visit(dependencyId);
        }
        visiting.delete(id);
        visited.add(id);
        sorted.push(manifest);
      }

      for (const id of requestedIds) visit(id);

      const capabilityOwners = new Map<string, string>();
      for (const manifest of sorted) {
        for (const capability of manifest.capabilities ?? []) {
          const owner = capabilityOwners.get(capability);
          if (owner) throw new Error(`capability ${capability} 同时由 ${owner} 与 ${manifest.id} 提供`);
          capabilityOwners.set(capability, manifest.id);
        }
      }

      const webContributions = new Map<string, unknown>();
      for (const webId of profile.web) {
        const owner = webById.get(webId);
        if (!owner?.web) throw new Error(`装配配置引用了未注册 Web 模块: ${webId}`);
        if (!enabledIds.has(owner.id)) throw new Error(`Web 模块 ${webId} 的服务端模块 ${owner.id} 未启用`);
        webContributions.set(webId, owner.web.contribution);
      }

      return Object.freeze({ profile, modules: Object.freeze(sorted), webContributions });
    },
  });
}
