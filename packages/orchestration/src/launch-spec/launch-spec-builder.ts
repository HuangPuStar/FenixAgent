/**
 * LaunchSpecBuilder：从 envId + userId 聚合构建完整的 {@link LaunchSpec}。
 *
 * 构建流程（I3 设计文档）：
 *   1. `environmentRepo.getEnvironment(envId)` → agentConfigId、machineId
 *   2. `agentConfigRepo.getConfig(agentConfigId)` → 扁平配置（含 skills/kb/mcp）
 *   3. `agentEngineRepo.getEngine(agentConfig.engineId)` → 引擎信息
 *   4. 聚合为 LaunchSpec（cwd 按 `{workspaceRoot}/{organizationId}/{userId}/{environmentId}` 计算）
 *
 * 任一环节数据缺失（环境/配置/引擎不存在，或必要字段为空）统一抛
 * {@link LaunchSpecBuildError}，message 携带缺失环节的诊断上下文；
 * 编排域不读取环境变量，workspaceRoot 由宿主注入，默认 `workspaces`。
 */

import { LaunchSpecBuildError } from "../errors";
import type { AgentConfigRepo, AgentEngineRepo, EnvironmentRepo } from "../types/deps";
import type { LaunchSpec } from "./types";

/** LaunchSpecBuilder 构造依赖（全部由宿主注入，保证可单测）。 */
export interface LaunchSpecBuilderDeps {
  agentConfigRepo: AgentConfigRepo;
  environmentRepo: EnvironmentRepo;
  agentEngineRepo: AgentEngineRepo;
  /** 工作区根目录（相对或绝对路径），默认 "workspaces"。 */
  workspaceRoot?: string;
}

const DEFAULT_WORKSPACE_ROOT = "workspaces";

/** 按 envId + userId 构建完整 LaunchSpec。 */
export class LaunchSpecBuilder {
  readonly #agentConfigRepo: AgentConfigRepo;
  readonly #environmentRepo: EnvironmentRepo;
  readonly #agentEngineRepo: AgentEngineRepo;
  readonly #workspaceRoot: string;

  constructor(deps: LaunchSpecBuilderDeps) {
    this.#agentConfigRepo = deps.agentConfigRepo;
    this.#environmentRepo = deps.environmentRepo;
    this.#agentEngineRepo = deps.agentEngineRepo;
    this.#workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  }

  /** 从 envId + userId 构建完整 LaunchSpec；缺失字段抛 LaunchSpecBuildError（含诊断）。 */
  async build(envId: string, userId: string): Promise<LaunchSpec> {
    // 1. 环境：不存在或缺少配置引用时无法继续
    const environment = await this.#environmentRepo.getEnvironment(envId);
    if (environment === null) {
      throw new LaunchSpecBuildError(`Cannot build launch spec: environment '${envId}' not found`);
    }
    if (!environment.agentConfigId) {
      throw new LaunchSpecBuildError(
        `Cannot build launch spec: environment '${envId}' has no agentConfigId configured`,
      );
    }

    // 2. Agent 配置：扁平聚合，缺失或关键字段为空直接阻断启动，避免运行时伪成功
    const agentConfig = await this.#agentConfigRepo.getConfig(environment.agentConfigId);
    if (agentConfig === null) {
      throw new LaunchSpecBuildError(
        `Cannot build launch spec: agent config '${environment.agentConfigId}' not found (referenced by environment '${envId}')`,
      );
    }
    const missingField = this.#findMissingConfigField(agentConfig);
    if (missingField !== null) {
      throw new LaunchSpecBuildError(
        `Cannot build launch spec: agent config '${agentConfig.id}' is missing required field '${missingField}'`,
      );
    }

    // 3. 引擎：按配置引用的 engineId 解析引擎信息
    const engine = await this.#agentEngineRepo.getEngine(agentConfig.engineId);
    if (engine === null) {
      throw new LaunchSpecBuildError(
        `Cannot build launch spec: engine '${agentConfig.engineId}' not found (referenced by agent config '${agentConfig.id}')`,
      );
    }

    // 4. 聚合：cwd 遵循项目 workspace 路径不变量
    //    `{WORKSPACE_ROOT}/{organizationId}/{userId}/{environmentId}`
    return {
      environmentId: envId,
      agentConfig,
      engine,
      cwd: `${this.#workspaceRoot}/${environment.organizationId}/${userId}/${envId}`,
      userId,
    };
  }

  /** 返回首个缺失/为空的必要配置字段名；全部有效时返回 null。 */
  #findMissingConfigField(config: { name: string; modelName: string; engineId: string }): string | null {
    const required: Record<keyof typeof config, string> = {
      name: "name",
      modelName: "modelName",
      engineId: "engineId",
    };
    for (const key of Object.keys(required) as (keyof typeof config)[]) {
      if (!config[key]) {
        return required[key];
      }
    }
    return null;
  }
}
