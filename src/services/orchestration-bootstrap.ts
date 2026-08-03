/**
 * 编排域装配层：构造并缓存 AgentController / LaunchSpecBuilder 单例（I4 集成第二阶段）。
 *
 * 依赖全部来自 src/ 侧已实现的 Repo 单例与 bridge 单例：
 *   - agentNodeService：src/services/local-node-service.ts 的本地节点感知包装
 *     （local-default 占位节点 + src/transport/agent-node-bridge.ts 的真实节点委托）
 *   - agentConfigRepo / agentEngineRepo / environmentOrchestrationRepo：
 *     I4 第一阶段实现的编排域 Repo（src/repositories/）
 *   - workspaceRoot：config.workspaceRoot（WORKSPACE_ROOT 环境变量，默认 cwd/workspaces）
 *
 * 单例缓存是必要的：AgentController 内部维护活跃实例表，多个实例会各自持有一份
 * 互不可见的实例表，导致 stopInstance / listInstances 语义分裂。
 */

import { AgentController, LaunchSpecBuilder } from "@fenix/orchestration";
import { config } from "../config";
import { agentConfigRepo, agentEngineRepo, environmentOrchestrationRepo } from "../repositories";
import { localNodeAwareAgentNodeService } from "./local-node-service";

let launchSpecBuilder: LaunchSpecBuilder | null = null;

/** 获取 LaunchSpecBuilder 单例（按 envId + userId 聚合构建编排域 LaunchSpec）。 */
export function getOrchestrationLaunchSpecBuilder(): LaunchSpecBuilder {
  if (!launchSpecBuilder) {
    launchSpecBuilder = new LaunchSpecBuilder({
      agentConfigRepo,
      environmentRepo: environmentOrchestrationRepo,
      agentEngineRepo,
      // config.ts 已 resolve 保证非 null（WORKSPACE_ROOT 默认 ./workspaces）
      workspaceRoot: config.workspaceRoot,
    });
  }
  return launchSpecBuilder;
}

let controller: AgentController | null = null;

/** 获取编排域 AgentController 单例（spawn/stop/list 的统一入口）。 */
export function getOrchestrationController(): AgentController {
  if (!controller) {
    controller = new AgentController({
      // 本地节点感知包装：无 machineId 的环境回退 local-default 时返回本地占位节点，
      // 其余 machineId 委托真实 AgentNodeService（远程机器 WS 节点）。
      agentNodeService: localNodeAwareAgentNodeService,
      launchSpecBuilder: getOrchestrationLaunchSpecBuilder(),
      environmentRepo: environmentOrchestrationRepo,
    });
  }
  return controller;
}

/** 重置单例缓存（仅用于测试）。 */
export function resetOrchestrationBootstrap(): void {
  controller = null;
  launchSpecBuilder = null;
}
