/**
 * AgentController：编排域的统一入口。
 *
 * 职责：
 *   - `spawnInstance` 串联全部子域（环境校验 → 并发检查 → LaunchSpec 构建 →
 *     AgentNode 获取 → Instance 工厂），为外部提供统一的实例创建入口
 *   - `stopInstance` / `listInstances` 管理内存中的活跃实例表（纯运行时，无 DB 持久化）
 *
 * 错误映射（I3 设计文档）：
 *   | 场景                      | 异常                        |
 *   |---------------------------|-----------------------------|
 *   | envId 不存在              | EnvironmentNotFoundError    |
 *   | 并发超限                  | ConcurrencyExceededError    |
 *   | Machine 未连接            | AgentNodeUnavailableError   |
 *   | LaunchSpec 缺失字段       | LaunchSpecBuildError        |
 *   | 环境未配置 machineId      | LaunchSpecBuildError        |
 *   | stopInstance 目标不存在   | OrchestrationError          |
 *
 * 并发检查基于内存实例表，不依赖 DB；多实例并发 spawn 的竞态由宿主侧的
 * 幂等/重试策略兜底（编排域保持单一职责，不引入分布式锁）。
 */

import type { AgentNodeServicePort } from "../agent-node/types";
import {
  ConcurrencyExceededError,
  EnvironmentNotFoundError,
  LaunchSpecBuildError,
  OrchestrationError,
} from "../errors";
import type { Instance } from "../instance/instance";
import type { LaunchSpecBuilder } from "../launch-spec/launch-spec-builder";
import type { EnvironmentRepo } from "../types/deps";

/** AgentController 构造依赖（全部由宿主注入，保证可单测）。 */
export interface AgentControllerDeps {
  agentNodeService: AgentNodeServicePort;
  launchSpecBuilder: LaunchSpecBuilder;
  environmentRepo: EnvironmentRepo;
}

/** 编排域统一入口：创建 / 查询 / 停止 Agent 运行实例。 */
export class AgentController {
  readonly #agentNodeService: AgentNodeServicePort;
  readonly #launchSpecBuilder: LaunchSpecBuilder;
  readonly #environmentRepo: EnvironmentRepo;
  /** 活跃实例表（instanceId → Instance），停止后移除。 */
  readonly #instances = new Map<string, Instance>();

  constructor(deps: AgentControllerDeps) {
    this.#agentNodeService = deps.agentNodeService;
    this.#launchSpecBuilder = deps.launchSpecBuilder;
    this.#environmentRepo = deps.environmentRepo;
  }

  /** 创建 Agent 运行实例（完整 6 步流程，见类注释错误映射）。 */
  async spawnInstance(envId: string, userId: string): Promise<Instance> {
    // 1. 环境校验
    const environment = await this.#environmentRepo.getEnvironment(envId);
    if (environment === null) {
      throw new EnvironmentNotFoundError(`Environment '${envId}' not found`);
    }

    // 2. 并发检查：当前环境中活跃实例数 vs maxConcurrency
    const activeCount = [...this.#instances.values()].filter(
      (instance) => instance.environmentId === envId && instance.status() !== "stopped",
    ).length;
    if (activeCount >= environment.maxConcurrency) {
      throw new ConcurrencyExceededError(
        `Environment '${envId}' reached max concurrency (${environment.maxConcurrency})`,
      );
    }

    // 3. 构建 LaunchSpec（缺失字段抛 LaunchSpecBuildError）
    const launchSpec = await this.#launchSpecBuilder.build(envId, userId);

    // 4. 获取 AgentNode；环境须解析出有效 machineId（宿主 Repo 负责默认值 fallback，
    //    编排域不读取环境变量，缺失视为配置错误）。
    //    ensureNode 在节点不存在或已关闭时抛 AgentNodeUnavailableError。
    const machineId = environment.machineId;
    if (!machineId) {
      throw new LaunchSpecBuildError(`Cannot spawn instance: environment '${envId}' has no machineId configured`);
    }
    const agentNode = this.#agentNodeService.ensureNode(machineId);

    // 5. 创建 Instance（AgentNode 工厂）
    const instance = agentNode._spawnInstance(launchSpec);

    // 6. 注册前二次并发校验（同步段，无 await 间隙）：步骤 2 的检查在
    //    launchSpecBuilder.build 的 await 之后可能已过期（并发 spawn 在此期间完成
    //    注册），超限时回滚（归还节点引用、不注册），避免超发实例。
    const activeCountNow = [...this.#instances.values()].filter(
      (i) => i.environmentId === envId && i.status() !== "stopped",
    ).length;
    if (activeCountNow >= environment.maxConcurrency) {
      try {
        this.#agentNodeService.releaseNode(machineId);
      } catch {
        // 节点可能已被外部关闭（重试耗尽回收），引用归还失败可忽略
      }
      throw new ConcurrencyExceededError(
        `Environment '${envId}' reached max concurrency (${environment.maxConcurrency})`,
      );
    }

    // 7. 注册并返回引用
    this.#instances.set(instance.instanceId, instance);
    return instance;
  }

  /** 停止指定实例：通知 Agent 进程停止、归还节点引用并移出活跃表；目标不存在抛 OrchestrationError。 */
  async stopInstance(instanceId: string): Promise<void> {
    const instance = this.#instances.get(instanceId);
    if (instance === undefined) {
      throw new OrchestrationError(`Instance '${instanceId}' not found`, "INSTANCE_NOT_FOUND");
    }
    this.#terminateInstance(instance);
  }

  /**
   * 批量终止指定机器上的全部活跃实例（机器断连/重连删除 core 实例时宿主调用）。
   *
   * 背景：机器断连/重连路径（core-bootstrap.unregisterRemoteNode /
   * registerRemoteNode 重连分支）只删除 core 实例与 supplement，若不同步清理
   * 本活跃表，幽灵实例会永久计入环境并发额度（maxConcurrency=1 时环境永久
   * 无法再 spawn），且节点引用计数残留导致空闲回收不触发（E-P0.1）。
   *
   * 与 stopInstance 的语义差异：批量场景无"目标不存在"概念，不抛
   * INSTANCE_NOT_FOUND；重复调用幂等（表内无匹配实例时直接返回 0）。
   * @param machineId 目标机器 ID（与 Instance.machineId 匹配）
   * @returns 实际清理的实例数
   */
  stopInstancesByMachineId(machineId: string): number {
    let removed = 0;
    // 快照遍历：终止过程会从活跃表删除条目，迭代中删除可变 Map 不安全
    for (const instance of [...this.#instances.values()]) {
      if (instance.machineId !== machineId) continue;
      this.#terminateInstance(instance);
      removed += 1;
    }
    return removed;
  }

  /** 列出当前所有活跃实例（已停止的实例不包含在内）。 */
  listInstances(): Instance[] {
    return [...this.#instances.values()].filter((instance) => instance.status() !== "stopped");
  }

  /**
   * 终止单个实例的公共收尾：通知 Agent 停止（仅节点 connected 时发停止帧）、
   * 移出活跃表并归还节点引用。stopInstance 与 stopInstancesByMachineId 共用。
   * 引用归还失败（节点已被外部关闭/空闲回收）时忽略，实例停止本身已成功。
   */
  #terminateInstance(instance: Instance): void {
    instance.stop();
    this.#instances.delete(instance.instanceId);
    // 归还 AgentNode 引用（与 spawnInstance 的 ensureNode 配对）；引用归零后由
    // AgentNodeService 按空闲超时回收节点。
    try {
      this.#agentNodeService.releaseNode(instance.machineId);
    } catch {
      // 节点已不在管理集合（如已被空闲回收或外部关闭）时忽略，实例停止本身已成功
    }
  }
}
