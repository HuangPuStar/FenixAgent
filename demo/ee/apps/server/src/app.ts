import { AgentConfigRunFacade } from "@fenix-ce/agent-config";
import { AgentInstanceManager } from "@fenix-ce/agent-instance";
import type { AgentRuntimeModule } from "@fenix-ce/agent-runtime";
import { type AccessControlModule, createModuleRegistry, defineApplication } from "@fenix-ce/platform-sdk";
import type { AssemblyProfile } from "@fenix-ce/platform-sdk/assembly";
import { type AgentConfigApprovalPolicy, EnterpriseAgentConfigFacade } from "@fenix-ee/agent-config";
import { generatedModuleManifests } from "../../generated/module-registry";
import { eeAssemblyConfig } from "./assembly-config";

/** 由 EE 构建脚本收集 EE 包与固定 CE submodule manifest 后生成。 */
const moduleRegistry = createModuleRegistry(generatedModuleManifests);

/**
 * 企业版替换授权、扩展发布模块，却继续使用 CE runtime。
 * app 只保留领域对象之间的依赖注入，不再手写任何包到模块 ID 的注册逻辑。
 */
export function assembleEeApplication(config: AssemblyProfile) {
  moduleRegistry.assertDependencies(config.resources);
  if (!config.resources.includes("agent-config-publication")) throw new Error("EE demo 必须装配发布模块");
  const accessControl = moduleRegistry.create<AccessControlModule & AgentConfigApprovalPolicy>(
    config.accessControl,
    "access-control",
  );
  const agentRuntime = moduleRegistry.create<AgentRuntimeModule>(config.runtime, "runtime");
  const agentConfigs = new EnterpriseAgentConfigFacade(accessControl, accessControl);
  const instanceManager = new AgentInstanceManager(agentRuntime, "ee");
  return defineApplication({
    edition: "ee",
    accessControl,
    agentRuntime,
    agentConfigs,
    instanceManager,
    agentRuns: new AgentConfigRunFacade(agentConfigs, instanceManager),
    resourceModules: config.resources.map((resourceId) => moduleRegistry.requireResource(resourceId)),
  });
}

/** demo 默认装配 deploy/assembly/ee.json 指定的模块组合。 */
export const eeApp = assembleEeApplication(eeAssemblyConfig);
