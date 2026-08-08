import { describe, expect, test } from "bun:test";
import { OpenSandboxClusterProvider } from "@fenix/sandbox-provider";
import { registerConfiguredSandboxProviders } from "../services/sandbox";
import { SandboxProviderRegistry } from "../services/sandbox/sandbox-provider-registry";

describe("sandbox provider configuration", () => {
  // 完整配置时应注册 OpenSandbox Cluster Provider。
  test("registers the configured OpenSandbox Cluster provider", () => {
    const registry = new SandboxProviderRegistry();
    registerConfiguredSandboxProviders(registry, {
      openSandboxClusterUrl: "http://cluster.test",
      openSandboxClusterApiKey: "cluster-key",
      sandboxProviderRequestTimeoutMs: 5000,
      sandboxProviderCreateTimeoutMs: 30000,
      sandboxProviderResumeTimeoutMs: 30000,
      sandboxProviderDestroyTimeoutMs: 30000,
    });

    expect(registry.get("opensandbox-cluster")).toBeInstanceOf(OpenSandboxClusterProvider);
  });

  // 缺少任一必需配置时不能注册一个不可用的 Provider。
  test("does not register an incomplete configuration", () => {
    const registry = new SandboxProviderRegistry();
    registerConfiguredSandboxProviders(registry, {
      openSandboxClusterUrl: "http://cluster.test",
      openSandboxClusterApiKey: "",
      sandboxProviderRequestTimeoutMs: 5000,
      sandboxProviderCreateTimeoutMs: 30000,
      sandboxProviderResumeTimeoutMs: 30000,
      sandboxProviderDestroyTimeoutMs: 30000,
    });

    expect(() => registry.get("opensandbox-cluster")).toThrow("not configured");
  });
});
