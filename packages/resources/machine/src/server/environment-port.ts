// environment-port.ts — 本包对 agent-runtime 两处 environment 读取的可替换句柄
//
// 为什么需要这一层：`getOwnedEnvironment`（环境归属校验）与 `environmentRepo.getById`（环境记录读取）既被
// 本包路由/服务调用，又被宿主测试按解析后的真实路径做模块级替换（`apps/server/src/test-utils/setup-mocks.ts`
// 替换 `@fenix/agent-runtime/server` 的导出）。收敛为一个包内可替换句柄后：
//   - 默认实现按调用时读取模块导出（live binding），宿主的模块级替换仍然生效；
//   - 包内用例经 `@fenix/resource-machine/server/testing` 的 `stubMachineEnvironment` 直接替换，既不需要
//     构造 environment 的读写链路，也不依赖宿主 preload 里的替身注册表（那是宿主内部路径，包不得导入）。
//
// 只放这两个原语：本包其余 agent-runtime 读取各有自己的入口——core runtime 句柄走
// `machine-runtime.ts` 的绑定端口，连接查询走 `file-machine-events.ts` 的绑定端口，事件总线走
// `src/services/event-service.ts`。1.4 收敛 `machine → agent-runtime` 边时，本文件的两个原语改为宿主绑定
// 端口（`bindMachineEnvironmentPort`），调用方无需改动。

import type { EnvironmentRole } from "@fenix/agent-runtime/server";
import { environmentRepo, getOwnedEnvironment as getOwnedEnvironmentReal } from "@fenix/agent-runtime/server";

/**
 * 本包读到的环境记录视图。
 *
 * 本包只读四个字段（`id` / `organizationId` / `userId` / `agentConfigId`：workspace 目录推导、归属判定与
 * Agent 配置解析）。形态理由与 `types/auth.ts` 的 `MachineRequestAuth` 一致：直接沿用 agent-runtime 的
 * `EnvironmentRecord`（20 个必填字段）会把包外的持久化模型钉进本包契约——上游加一列就波及本包类型，包内
 * 用例也必须构造整条记录才能替换一个原语。agent-runtime 的完整记录结构上满足本视图，无需转换。
 */
export interface MachineEnvironmentRecord {
  readonly id: string;
  readonly organizationId?: string | null;
  readonly userId?: string | null;
  readonly agentConfigId?: string | null;
}

/** environment 读取能力：记录读取 + 归属校验。 */
export interface MachineEnvironmentPort {
  /** 按环境 ID 读取记录；不存在返回 null（调用方据 null 走各自的分支语义）。 */
  getEnvironmentById(environmentId: string): Promise<MachineEnvironmentRecord | null | undefined>;
  /** 归属校验：环境不属于该组织/用户时抛错；`role` 为 W17 角色检查的透传扩展位。 */
  getOwnedEnvironment(
    environmentId: string,
    organizationId: string,
    userId?: string,
    role?: EnvironmentRole,
  ): Promise<MachineEnvironmentRecord>;
}

let override: Partial<MachineEnvironmentPort> | null = null;

/**
 * 替换环境读取实现（测试装配用）。
 *
 * 浅合并语义：只传需要替换的原语；传 `null` 恢复为包内真实实现。复位统一走
 * `@fenix/resource-machine/server/testing` 登记的 `registerStubResetter`，避免用例之间配置泄漏。
 */
export function setMachineEnvironmentPort(overrides: Partial<MachineEnvironmentPort> | null): void {
  override = overrides ? { ...override, ...overrides } : null;
}

/** 读取当前生效的环境读取实现（替换值优先，否则为 agent-runtime 的真实实现）。 */
export function getMachineEnvironmentPort(): MachineEnvironmentPort {
  return {
    getEnvironmentById: (environmentId) => (override?.getEnvironmentById ?? environmentRepo.getById)(environmentId),
    getOwnedEnvironment: (environmentId, organizationId, userId, role) =>
      (override?.getOwnedEnvironment ?? getOwnedEnvironmentReal)(environmentId, organizationId, userId, role),
  };
}

/** 环境记录读取（走当前生效的实现）。 */
export const getEnvironmentById: MachineEnvironmentPort["getEnvironmentById"] = (environmentId) =>
  getMachineEnvironmentPort().getEnvironmentById(environmentId);

/** 环境归属校验（走当前生效的实现）。 */
export const getOwnedEnvironment: MachineEnvironmentPort["getOwnedEnvironment"] = (
  environmentId,
  organizationId,
  userId,
  role,
) => getMachineEnvironmentPort().getOwnedEnvironment(environmentId, organizationId, userId, role);
