import { OpenSandboxClusterProvider, type OpenSandboxClusterProviderConfig } from "@fenix/sandbox-provider";
import { config } from "../../config";
import { SandboxExecutionHandler } from "./sandbox-execution-handler";
import { SandboxManager } from "./sandbox-manager";
import { SandboxProviderRegistry } from "./sandbox-provider-registry";

export const sandboxProviderRegistry = new SandboxProviderRegistry();
export const sandboxManager = new SandboxManager({ providers: sandboxProviderRegistry });
export const sandboxExecutionHandler = new SandboxExecutionHandler(sandboxManager);

export type SandboxProviderConfig = {
  openSandboxClusterUrl?: string;
  openSandboxClusterApiKey?: string;
  sandboxProviderRequestTimeoutMs: number;
  sandboxProviderCreateTimeoutMs: number;
  sandboxProviderResumeTimeoutMs: number;
  sandboxProviderDestroyTimeoutMs: number;
};

/** 根据应用配置注册可用的沙盒 Provider，不在模块加载阶段发起网络请求。 */
export function registerConfiguredSandboxProviders(
  registry: SandboxProviderRegistry = sandboxProviderRegistry,
  settings: SandboxProviderConfig = config,
): void {
  if (!settings.openSandboxClusterUrl || !settings.openSandboxClusterApiKey) return;
  const providerConfig: OpenSandboxClusterProviderConfig = {
    baseUrl: settings.openSandboxClusterUrl,
    apiKey: settings.openSandboxClusterApiKey,
    requestTimeoutMs: settings.sandboxProviderRequestTimeoutMs,
    createTimeoutMs: settings.sandboxProviderCreateTimeoutMs,
    resumeTimeoutMs: settings.sandboxProviderResumeTimeoutMs,
    destroyTimeoutMs: settings.sandboxProviderDestroyTimeoutMs,
  };
  registry.register("opensandbox-cluster", new OpenSandboxClusterProvider(providerConfig));
}

export { SandboxExecutionHandler } from "./sandbox-execution-handler";
export { SandboxManager } from "./sandbox-manager";
export { SandboxProviderRegistry } from "./sandbox-provider-registry";
