import { AgentConfigFacade, AgentConfigRunFacade, InMemoryAgentConfigRepository } from "@fenix-ce/agent-config";
import { AgentInstanceManager } from "@fenix-ce/agent-instance";
import type { AgentRuntimeModule } from "@fenix-ce/agent-runtime";
import {
  type AccessControlModule,
  createModuleRegistry,
  defineApplication,
  type ModuleFactoryContext,
  type ModuleManifest,
  type ResourceScopeStoreBinding,
} from "@fenix-ce/platform-sdk";
import type { AssemblyProfile } from "@fenix-ce/platform-sdk/assembly";
import { generatedModuleManifests } from "../../generated/module-registry";

/** 此 registry 是构建期脚本生成的静态 import 集合，不由 app 手工维护。 */
const moduleRegistry = createModuleRegistry(generatedModuleManifests);

/** 先解析和校验模块集合，让 bootstrap 能在构造模块前汇总其 env 声明。 */
export function resolveCeModules(config: AssemblyProfile): readonly ModuleManifest[] {
  const enabledModuleIds = [config.accessControl, config.runtime, ...config.resources];
  const installedModules = moduleRegistry.resolveEnabled(enabledModuleIds);
  if (!config.resources.includes("agent-config")) {
    throw new Error("CE demo 必须装配 agent-config 资源模块");
  }
  return installedModules;
}

/** 配置驱动的静态装配：bootstrap 注入统一校验后的 env，再创建具体模块。 */
export function assembleCeApplication(
  config: AssemblyProfile,
  context: ModuleFactoryContext,
  installedModules = resolveCeModules(config),
) {
  const accessControl = moduleRegistry.create<AccessControlModule & ResourceScopeStoreBinding>(
    config.accessControl,
    "access-control",
    context,
  );
  const agentRuntime = moduleRegistry.create<AgentRuntimeModule>(config.runtime, "runtime", context);
  const agentConfigRepository = new InMemoryAgentConfigRepository();
  accessControl.bindResourceScopeStore(agentConfigRepository);
  const agentConfigs = new AgentConfigFacade(accessControl, agentConfigRepository);
  const instanceManager = new AgentInstanceManager(agentRuntime, "ce");
  return defineApplication({
    edition: "ce",
    accessControl,
    agentRuntime,
    agentConfigs,
    instanceManager,
    agentRuns: new AgentConfigRunFacade(agentConfigs, instanceManager),
    installedModules,
    resourceModules: config.resources.map((resourceId) => moduleRegistry.requireResource(resourceId)),
  });
}
