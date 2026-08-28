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
 *
 * Sandbox 执行节点：编排域 EnvironmentRepo 的 getEnvironment 是本层注入的执行节点
 * 解析器（见 PgEnvironmentOrchestrationRepo.setExecutionNodeResolver）的唯一装配点。
 * 解析器承载 sandbox 的业务语义（agentNode 解析 + prepare + 节点优先级），保持
 * repository 层不依赖 services 层。
 */

import { randomBytes } from "node:crypto";
import { AgentController, LaunchSpecBuilder } from "@fenix/orchestration";
import { config } from "../config";
import { AppError } from "../errors";
import { agentConfigRepo, agentEngineRepo, environmentOrchestrationRepo } from "../repositories";
import type { ExecutionNodeResolver } from "../repositories/environment-orchestration";
import { resolveAgentNode } from "./config/agent-config";
import { localNodeAwareAgentNodeService } from "./local-node-service";
import { sandboxExecutionHandler } from "./sandbox";

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

/**
 * 准备 sandbox 执行节点并返回其 machineId。
 *
 * 幂等性：SandboxManager.createOrReuse 按 provider + pool + userId 复用活跃实例，
 * 同一环境 + 用户的多次解析（AgentController 与 LaunchSpecBuilder 各调一次
 * getEnvironment）会命中同一 sandbox 实例，machineId 保持一致（A-P2.2 同源约束）。
 */
async function prepareSandboxNode(
  sandboxPoolId: string,
  userId: string,
  organizationId: string | null,
): Promise<string> {
  // sandbox 实例按 userId 归属（复用键 + machine 记录），空归属会导致跨请求复用
  // 与租户隔离失效；调用方（AgentController.spawnInstance）必传 userId，此处防御
  if (!userId) {
    throw new AppError("无法为未归属用户准备沙盒执行节点", "SANDBOX_USER_MISSING", 500);
  }
  const prepared = await sandboxExecutionHandler.prepare({
    sandboxId: `sbi_${randomBytes(12).toString("hex")}`,
    sandboxPoolId,
    userId,
    organizationId: organizationId ?? undefined,
  });
  return prepared.nodeId;
}

/**
 * 执行节点解析器工厂（R6）：决策逻辑与依赖分离，便于直接单测。
 *
 * 依赖以快照注入（prepareSandbox 实现 + sandbox 开关 + 默认资源池）：
 * 生产使用 config 单例与 sandboxExecutionHandler；测试注入 fake 依赖即可覆盖
 * 全部分支，无需触达 DB / provider。
 *
 * 解析优先级对齐旧 spawnInstanceFromEnvironment：
 * 显式 sandbox > 显式 machine > 默认 sandbox > 默认链（null）。
 *
 * 返回 null 表示无业务解析结果，由 EnvironmentRepo 走默认 fallback 链
 * （agentNode 为 null 时 agent_config.machineId 列 → RCS_DEFAULT_MACHINE_ID →
 * local-default；agentNode 存在时跳过列，与 resolveAgentNode 语义对齐）。
 */
export function createExecutionNodeResolver(
  deps: {
    prepareSandbox?: (sandboxPoolId: string, userId: string, organizationId: string | null) => Promise<string>;
    sandboxEnabled?: boolean;
    defaultSandboxPoolId?: string | null;
  } = {},
): ExecutionNodeResolver {
  const prepareSandbox = deps.prepareSandbox ?? prepareSandboxNode;

  // async：失败路径（含部署配置错误）统一以 rejected promise 表达，
  // 调用方 await 语义一致，避免同步 throw 在非 async 调用链中逃逸
  return async function resolveExecutionNode(input: {
    envId: string;
    organizationId: string | null;
    userId?: string;
    agentNode: unknown;
    configMachineId: string | null;
  }): Promise<string | null> {
    // 动态读取 config：config 单例初始为空 env 构建（src/config.ts 延迟解析设计），
    // 真实值由 index.ts 顶层 applyEnv(validateEnv()) 写入。本 resolver 在模块
    // 求值阶段创建，若在此冻结默认值会永久拿到空配置，导致默认沙盒策略在运行时
    // 失效（2026-08-17 事故：resolver 冻结 sandboxEnabled=false，spawn 静默回退
    // local-default）。deps 显式注入（测试）优先于 config 动态读取。
    const sandboxEnabled = deps.sandboxEnabled ?? config.sandboxEnabled;
    const defaultSandboxPoolId =
      deps.defaultSandboxPoolId === undefined ? config.defaultSandboxPoolId : deps.defaultSandboxPoolId;
    const agentNode = resolveAgentNode({ agentNode: input.agentNode, machineId: input.configMachineId });
    const explicitSandboxPoolId = agentNode?.kind === "sandbox" ? agentNode.sandboxPoolId : null;
    const explicitMachineId = agentNode?.kind === "machine" ? agentNode.machineId : null;

    // 显式 sandbox：环境绑定沙盒资源池，准备执行节点（含 ACP 回连等待）
    if (explicitSandboxPoolId) {
      return prepareSandbox(explicitSandboxPoolId, input.userId ?? "", input.organizationId);
    }
    // 显式 machine：agentNode 中显式声明的机器
    if (explicitMachineId) {
      return Promise.resolve(explicitMachineId);
    }
    // 默认 sandbox：未显式指定执行节点且启用了沙盒默认策略
    if (sandboxEnabled) {
      if (!defaultSandboxPoolId) {
        // 与旧路径语义对齐：沙盒已启用但缺少默认资源池属部署配置错误，明确拒绝
        throw new AppError("沙盒已开启但未配置默认资源池", "SANDBOX_DEFAULT_POOL_MISSING", 503);
      }
      return prepareSandbox(defaultSandboxPoolId, input.userId ?? "", input.organizationId);
    }
    // 其余场景交给 repo 默认链（machineId 列 → 系统默认机器 → local-default）
    return Promise.resolve(null);
  };
}

// 默认 resolver 实例（生产装配；幂等：重复调用仅重复赋值同一实现）
const resolveExecutionNode = createExecutionNodeResolver();
environmentOrchestrationRepo.setExecutionNodeResolver(resolveExecutionNode);

/** 重置单例缓存（仅用于测试）。 */
export function resetOrchestrationBootstrap(): void {
  controller = null;
  launchSpecBuilder = null;
  // 测试注入自定义 resolver 后必须重置，避免跨测试污染
  environmentOrchestrationRepo.setExecutionNodeResolver(resolveExecutionNode);
}
