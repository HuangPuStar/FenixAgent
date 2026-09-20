import type { SandboxRouteInput, SandboxRouteResult } from "@fenix/resource-machine/server";
import { getSandboxConfig } from "../config";
import { findActiveSandboxInstance } from "../repositories/sandbox-instance-repository";
import { findReadableSandboxPoolById } from "../repositories/sandbox-pool-repository";

const NO_SANDBOX: SandboxRouteResult = { sandboxSelected: false, machineId: null };

/**
 * 解析环境在沙盒模式下应路由到的机器。
 *
 * 为什么这个判定归 sandbox：它读的是沙盒自己的模块配置（沙盒开关、默认池）与自己的池、实例表。
 * machine 的资源文件服务需要这个结果来决定文件请求发往哪台机器，但「环境该落在哪个池、池里有没有
 * 该用户的活跃实例」是沙盒资源的领域知识；由 machine 反向查询会让 `machine → sandbox` 边复活
 * （台账 `special-dependency`，owner 1.4）。现在由本包在模块装配时把本函数注入 machine 的
 * `MachineSandboxRoutePort`，方向与 `dependsOn: ["machine"]` 一致。
 *
 * 三分语义：
 * - 节点显式绑定机器（`boundToMachine`）→ 不选中沙盒，调用方回落默认机器；
 * - 选中沙盒（显式池，或开关开启且有默认池）→ `sandboxSelected: true`。此后**不再看**是否有可用实例：
 *   池不存在、跨组织不可读、无活跃实例都返回 `machineId: null`，由调用方按「沙盒已选中但无可用机器」
 *   处理，绝不回落到默认机器——回落会让用户以为文件在沙盒里，实际写到了别的机器；
 * - 未选中沙盒 → `sandboxSelected: false`。
 *
 * 显式池优先于全局开关：AgentNode 明确指定池时不因 `sandboxEnabled` 为假而静默失效。
 */
export async function resolveSandboxMachineRoute(input: SandboxRouteInput): Promise<SandboxRouteResult> {
  if (input.boundToMachine) return NO_SANDBOX;

  const config = getSandboxConfig();
  const poolId = input.explicitSandboxPoolId ?? (config.sandboxEnabled ? (config.defaultSandboxPoolId ?? null) : null);
  if (!poolId) return NO_SANDBOX;

  // 没有环境属主就没有可查询的主体，选中状态仍然成立
  if (!input.userId) return { sandboxSelected: true, machineId: null };

  const pool = await findReadableSandboxPoolById(poolId, input.organizationId);
  if (!pool) return { sandboxSelected: true, machineId: null };

  const instance = await findActiveSandboxInstance(pool.providerKey, pool.id, input.userId);
  return { sandboxSelected: true, machineId: instance?.machineId ?? null };
}
