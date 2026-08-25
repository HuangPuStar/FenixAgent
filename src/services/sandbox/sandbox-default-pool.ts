import type { NewSandboxPool, SandboxPool } from "../../db/schema";
import { upsertSandboxPool } from "../../repositories/sandbox-pool-repository";
import { parseSandboxResources } from "./sandbox-config";

export type SandboxDefaultPoolSettings = {
  sandboxEnabled: boolean;
  defaultSandboxPoolId?: string;
  defaultSandboxImage?: string;
  defaultSandboxAgentType?: string;
  defaultSandboxResourcesJson?: string;
  defaultSandboxExtraJson?: string;
};

type SandboxDefaultPoolRepository = {
  upsert(input: NewSandboxPool): Promise<SandboxPool>;
};

/** 根据启动配置创建或覆盖全局默认 Sandbox Pool。 */
export async function initializeDefaultSandboxPool(
  settings: SandboxDefaultPoolSettings,
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

  extra = { ...extra, agent_type: settings.defaultSandboxAgentType ?? "peri" };

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
