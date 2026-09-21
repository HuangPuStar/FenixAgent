import type { NewSandboxPool, SandboxPool } from "@fenix/resource-sandbox/db";
import { getSandboxConfig, type SandboxModuleConfig } from "../config";
import { upsertSandboxPool } from "../repositories/sandbox-pool-repository";
import { parseSandboxResources } from "./sandbox-config";

/**
 * 默认资源池引导读取的配置面。
 *
 * 定义为模块配置的子集（而非独立结构）：字段只能来自 `SandboxModuleConfig`，两处定义不会漂移，
 * 同时让调用方可以只注入引导相关字段（测试不需要构造完整运行时超时配置）。
 */
export type SandboxDefaultPoolSettings = Pick<
  SandboxModuleConfig,
  | "sandboxEnabled"
  | "defaultSandboxPoolId"
  | "defaultSandboxImage"
  | "defaultSandboxAgentType"
  | "defaultSandboxResourcesJson"
  | "defaultSandboxExtraJson"
>;

type SandboxDefaultPoolRepository = {
  upsert(input: NewSandboxPool): Promise<SandboxPool>;
};

/** 根据本模块配置创建或覆盖全局默认 Sandbox Pool。 */
export async function initializeDefaultSandboxPool(
  settings: SandboxDefaultPoolSettings = getSandboxConfig(),
  repository: SandboxDefaultPoolRepository = { upsert: upsertSandboxPool },
): Promise<SandboxPool | null> {
  if (!settings.sandboxEnabled) return null;
  if (!settings.defaultSandboxPoolId || !settings.defaultSandboxImage || !settings.defaultSandboxResourcesJson) {
    throw new Error(
      "RCS_SANDBOX_ENABLED=true requires RCS_DEFAULT_SANDBOX_POOL_ID, RCS_DEFAULT_SANDBOX_IMAGE and RCS_DEFAULT_SANDBOX_RESOURCES_JSON",
    );
  }

  let resources: unknown;
  try {
    resources = JSON.parse(settings.defaultSandboxResourcesJson);
  } catch (error) {
    throw new Error("RCS_DEFAULT_SANDBOX_RESOURCES_JSON must be valid JSON", { cause: error });
  }

  let extra: unknown = {};
  if (settings.defaultSandboxExtraJson) {
    try {
      extra = JSON.parse(settings.defaultSandboxExtraJson);
    } catch (error) {
      throw new Error("RCS_DEFAULT_SANDBOX_EXTRA_JSON must be valid JSON", { cause: error });
    }
  }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
    throw new Error("sandbox pool extra must be an object");
  }

  extra = { ...extra, agent_type: settings.defaultSandboxAgentType ?? "opencode" };

  return repository.upsert({
    id: settings.defaultSandboxPoolId,
    name: settings.defaultSandboxPoolId,
    organizationId: null,
    providerKey: "opensandbox-cluster",
    image: settings.defaultSandboxImage,
    defaultResources: parseSandboxResources(resources),
    extra,
  });
}
