import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

/**
 * 组织页在这里装配：机器注册表能力由本适配器注入，而不是 identity 包直接依赖
 * `@fenix/resource-machine`——§2.3 的依赖矩阵禁止 platform 实现依赖 resources，
 * 组合只能发生在 apps（唯一的 composition root）。端口形状见 identity 的
 * `agent-organizations-types.ts`（`MachineRegistryPort`），字段漂移在这里变成类型错误。
 */
const Page = lazy(async () => {
  const [identity, machine] = await Promise.all([import("@fenix/identity/web"), import("@fenix/resource-machine/web")]);

  function OrganizationsPage() {
    return <identity.AgentOrganizationsPage machineRegistry={machine.registryApi} />;
  }

  return { default: OrganizationsPage };
});

export const Route = createFileRoute("/agent/_panel/organizations")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <Page />
    </Suspense>
  ),
});
