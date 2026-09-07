import { AgentConfigRunFacade } from "@fenix-ce/agent-config";
import { AgentInstanceManager } from "@fenix-ce/agent-instance";
import type { AgentRuntimeModule } from "@fenix-ce/agent-runtime";
import {
  type AccessControlModule,
  createModuleRegistry,
  defineApplication,
  type ModuleFactoryContext,
  type ModuleManifest,
} from "@fenix-ce/platform-sdk";
import type { AssemblyProfile } from "@fenix-ce/platform-sdk/assembly";
import { type AgentConfigApprovalPolicy, EnterpriseAgentConfigFacade } from "@fenix-ee/agent-config";
import { generatedModuleManifests } from "../../generated/module-registry";

/** 由 EE 构建脚本收集 EE 包与固定 CE submodule manifest 后生成。 */
const moduleRegistry = createModuleRegistry(generatedModuleManifests);

/**
 * 企业版替换授权、扩展发布模块，却继续使用 CE runtime。
 * app 只保留领域对象之间的依赖注入，不再手写任何包到模块 ID 的注册逻辑。
 */
export function resolveEeModules(config: AssemblyProfile): readonly ModuleManifest[] {
  const enabledModuleIds = [config.accessControl, config.runtime, ...config.resources];
  const installedModules = moduleRegistry.resolveEnabled(enabledModuleIds);
  if (!config.resources.includes("agent-config-publication")) throw new Error("EE demo 必须装配发布模块");
  return installedModules;
}

/** bootstrap 注入统一校验后的 env；EE 只替换模块，不复制 CE 的装配协议。 */
export function assembleEeApplication(
  config: AssemblyProfile,
  context: ModuleFactoryContext,
  installedModules = resolveEeModules(config),
) {
  const accessControl = moduleRegistry.create<AccessControlModule & AgentConfigApprovalPolicy>(
    config.accessControl,
    "access-control",
    context,
  );
  const agentRuntime = moduleRegistry.create<AgentRuntimeModule>(config.runtime, "runtime", context);
  const agentConfigs = new EnterpriseAgentConfigFacade(accessControl, accessControl);
  const instanceManager = new AgentInstanceManager(agentRuntime, "ee");
  return defineApplication({
    edition: "ee",
    accessControl,
    agentRuntime,
    agentConfigs,
    instanceManager,
    agentRuns: new AgentConfigRunFacade(agentConfigs, instanceManager),
    installedModules,
    resourceModules: config.resources.map((resourceId) => moduleRegistry.requireResource(resourceId)),
  });
}
