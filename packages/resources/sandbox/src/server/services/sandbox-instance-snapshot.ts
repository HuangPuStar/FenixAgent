import type { SandboxResources } from "@fenix/sandbox-provider";
import { parseSandboxResources, type SandboxResolvedConfig } from "./sandbox-config";
import { SandboxStateError } from "./sandbox-errors";

/**
 * Sandbox Instance 配置快照的构造与读取。
 *
 * 快照是"创建资源时的所见"：Manager 写入 DB 的 `resolvedConfig`，重建资源时按它复现同一份配置。
 * 因此构造（pool 默认值 + 覆盖值 + machine 环境变量）与读取（JSONB 反序列化）必须成对演进，
 * 放在同一文件里，避免改了一侧的键名而另一侧仍在读旧键。
 *
 * 非法快照一律抛错：残缺配置交给 Provider 只会得到难以定位的远程错误。
 */

/** Instance 绑定的 machine_id 由 sandbox_id 派生：重试必须复用同一条 Machine 身份，不能每次新建。 */
export function sandboxMachineId(sandboxId: string): string {
  return `mach_sandbox_${sandboxId}`;
}

/** 校验资源池的 `defaultResources` 快照，缺失字段在创建资源前暴露。 */
export function asSandboxResources(value: unknown): SandboxResources {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SandboxStateError("sandbox pool default resources are invalid");
  }
  const resources = value as Partial<SandboxResources>;
  if (
    typeof resources.cpu !== "number" ||
    typeof resources.memoryMb !== "number" ||
    typeof resources.diskGb !== "number" ||
    typeof resources.gpuCount !== "number" ||
    !resources.environment ||
    !Array.isArray(resources.volumes)
  ) {
    throw new SandboxStateError("sandbox pool default resources are incomplete");
  }
  return resources as SandboxResources;
}

/** 把 machine_id 注入 Provider 配置环境变量：沙盒内的 Agent 进程靠它回连主服务并被寻址。 */
export function withMachineId(config: SandboxResolvedConfig, machineId: string): SandboxResolvedConfig {
  return {
    ...config,
    resources: {
      ...config.resources,
      environment: { ...config.resources.environment, RCS_MACHINE_ID: machineId },
    },
  };
}

/** 从持久化快照重建创建参数；`providerExtra` 允许为空（Provider 无额外参数时是常态）。 */
export function readSandboxResolvedConfig(value: unknown): SandboxResolvedConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SandboxStateError("sandbox instance resolved config is invalid");
  }
  const config = value as { image?: unknown; resources?: unknown; providerExtra?: unknown };
  if (typeof config.image !== "string") throw new SandboxStateError("sandbox instance image snapshot is invalid");
  return {
    image: config.image,
    resources: parseSandboxResources(config.resources),
    providerExtra:
      config.providerExtra && typeof config.providerExtra === "object" && !Array.isArray(config.providerExtra)
        ? (config.providerExtra as Record<string, unknown>)
        : {},
  };
}
