import { posix } from "node:path";
import type { SandboxProviderExtra, SandboxResourceOverrides, SandboxResources } from "@fenix/sandbox-provider";

export type SandboxResolvedConfig = {
  image: string;
  resources: SandboxResources;
  providerExtra: SandboxProviderExtra;
};

const DEFAULT_SANDBOX_AGENT_TYPE = "peri";

function normalizeRelativeVolumePath(value: string): string {
  if (value.includes("\0")) throw new Error("sandbox volume path contains a NUL byte");

  const slashPath = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (/^[A-Za-z]:\//.test(slashPath)) {
    throw new Error("sandbox volume path must be relative");
  }

  const normalized = posix.normalize(slashPath);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("sandbox volume path escapes the user workspace");
  }
  return normalized === "." ? "" : normalized;
}

/** 将调用方的逻辑挂载源转换为稳定的用户工作区相对路径。 */
function resolveUserVolumePath(userId: string, source: string): string {
  const safeUserId = normalizeRelativeVolumePath(userId);
  if (!safeUserId) throw new Error("sandbox user id is required");

  const relativePath = normalizeRelativeVolumePath(source);
  return relativePath ? `${safeUserId}/${relativePath}` : safeUserId;
}

export function getProviderExtra(extra: unknown, providerKey: string): SandboxProviderExtra {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return {};
  const providerExtra = (extra as Record<string, unknown>)[providerKey];
  if (!providerExtra || typeof providerExtra !== "object" || Array.isArray(providerExtra)) return {};
  return providerExtra as SandboxProviderExtra;
}

/** 从 Sandbox Pool 的 extra 中读取 Machine 身份使用的 Agent 类型。 */
export function getSandboxAgentType(extra: unknown): string {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return DEFAULT_SANDBOX_AGENT_TYPE;
  const agentType = (extra as Record<string, unknown>).agent_type;
  return typeof agentType === "string" && agentType.length > 0 ? agentType : DEFAULT_SANDBOX_AGENT_TYPE;
}

/** 比较 JSON 配置内容，忽略数据库 JSONB 往返造成的对象键顺序变化。 */
export function sandboxConfigsEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;

  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray !== rightIsArray) return false;

  if (leftIsArray && rightIsArray) {
    const leftItems = left as unknown[];
    const rightItems = right as unknown[];
    return (
      leftItems.length === rightItems.length &&
      leftItems.every((item, index) => sandboxConfigsEqual(item, rightItems[index]))
    );
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sandboxConfigsEqual(leftRecord[key], rightRecord[key]))
  );
}

/** 校验未知 JSON 是否为完整的 Provider 资源配置。 */
export function parseSandboxResources(value: unknown): SandboxResources {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sandbox resources must be an object");
  }
  const resources = value as Partial<SandboxResources>;
  if (
    typeof resources.cpu !== "number" ||
    typeof resources.memoryMb !== "number" ||
    typeof resources.diskGb !== "number" ||
    typeof resources.gpuCount !== "number" ||
    !resources.environment ||
    Array.isArray(resources.environment) ||
    !Array.isArray(resources.volumes)
  ) {
    throw new Error("sandbox resources are incomplete");
  }
  return resources as SandboxResources;
}

/** 根据 pool 当前配置和 instance 覆盖值生成可持久化的最终配置快照。 */
export function resolveSandboxConfig(
  image: string,
  defaults: SandboxResources,
  overrides: SandboxResourceOverrides | null | undefined,
  providerExtra: SandboxProviderExtra = {},
  userId?: string,
): SandboxResolvedConfig {
  const resources = {
    ...defaults,
    ...(overrides ?? {}),
    environment: { ...defaults.environment, ...(overrides?.environment ?? {}) },
    volumes: overrides?.volumes ?? defaults.volumes,
  };

  return {
    image,
    resources: userId
      ? {
          ...resources,
          volumes: resources.volumes.map((volume) =>
            volume.source === undefined ? volume : { ...volume, source: resolveUserVolumePath(userId, volume.source) },
          ),
        }
      : resources,
    providerExtra,
  };
}
