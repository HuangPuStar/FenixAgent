import { AgentConfigFacade, AgentConfigRunFacade } from "@fenix-ce/agent-config";
import { AgentInstanceManager } from "@fenix-ce/agent-instance";
import type { AgentRuntimeModule } from "@fenix-ce/agent-runtime";
import { type AccessControlModule, createModuleRegistry, defineApplication } from "@fenix-ce/platform-sdk";
import type { AssemblyProfile } from "@fenix-ce/platform-sdk/assembly";
import { generatedModuleManifests } from "../../generated/module-registry";
import { ceAssemblyConfig } from "./assembly-config";

/** 此 registry 是构建期脚本生成的静态 import 集合，不由 app 手工维护。 */
const moduleRegistry = createModuleRegistry(generatedModuleManifests);

/** 配置驱动的静态装配：模块已随镜像构建，配置仅选择合法组合。 */
export function assembleCeApplication(config: AssemblyProfile) {
  moduleRegistry.assertDependencies(config.resources);
  if (!config.resources.includes("agent-config")) {
    throw new Error("CE demo 必须装配 agent-config 资源模块");
  }
  const accessControl = moduleRegistry.create<AccessControlModule>(config.accessControl, "access-control");
  const agentRuntime = moduleRegistry.create<AgentRuntimeModule>(config.runtime, "runtime");
  const agentConfigs = new AgentConfigFacade(accessControl);
  const instanceManager = new AgentInstanceManager(agentRuntime, "ce");
  return defineApplication({
    edition: "ce",
    accessControl,
    agentRuntime,
    agentConfigs,
    instanceManager,
    agentRuns: new AgentConfigRunFacade(agentConfigs, instanceManager),
    resourceModules: config.resources.map((resourceId) => moduleRegistry.requireResource(resourceId)),
  });
}

/** demo 默认读取 deploy/assembly/ce.json 指定的模块组合。 */
export const ceApp = assembleCeApplication(ceAssemblyConfig);
