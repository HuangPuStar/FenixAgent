// environment-port.ts — 本包对 environment 读取的可替换句柄
//
// 为什么需要这一层：环境归属校验（`getOwnedEnvironment`）与环境记录读取（`getEnvironmentById`）既被
// 本包路由/服务调用，又被用例替换。收敛为一个包内可替换句柄后：
//   - 生产实现在装配阶段由宿主经 `bindMachineEnvironmentPort` 绑定；
//   - 包内用例经 `@fenix/resource-machine/server/testing` 的 `stubMachineEnvironment` 直接替换，既不需要
//     构造 environment 的读写链路，也不依赖宿主 preload 里的替身注册表（那是宿主内部路径，包不得导入）。
//
// 归属：environment 的读写在 agent-runtime。本包此前直接导入 `@fenix/agent-runtime/server` 取值
// （台账 `special-dependency` / `no-circular`，owner 1.4），改为宿主绑定后该反向边消除。
//
// 只放这两个原语：本包其余宿主能力走 `host-port.ts`（Core runtime 运行态、file-ws 连接索引、
// workspace 路径计算）。
//
// 测试替换与宿主绑定是两层：`bindMachineEnvironmentPort` 是**装配**入口（一次绑定，重复绑定报错），
// `setMachineEnvironmentPort` 是**用例**替换入口（浅合并，可重复调用）。两者叠加时替换值优先，
// 因此用例可以只打桩需要替换的那一个原语，另一个继续走宿主实现。

/**
 * 组织成员角色。
 *
 * 值域与宿主认证上下文的 `role`、以及 agent-runtime `environment-core` 的 `EnvironmentRole` 一致。
 * 本包不导入 agent-runtime（1.4 依赖方向收敛），按 `MachineEnvironmentRecord` 的同一条理由在此收窄声明：
 * 只表达本包用到的取值；把上游类型钉进本包契约，会让上游调整字面量时无谓波及本包。
 */
export type EnvironmentRole = "owner" | "admin" | "member";

/**
 * 本包读到的环境记录视图。
 *
 * 本包只读四个字段（`id` / `organizationId` / `userId` / `agentConfigId`：workspace 目录推导、归属判定与
 * Agent 配置解析）。形态理由与 `types/auth.ts` 的 `MachineRequestAuth` 一致：直接沿用 agent-runtime 的
 * `EnvironmentRecord`（20 个必填字段）会把包外的持久化模型钉进本包契约——上游加一列就波及本包类型，包内
 * 用例也必须构造整条记录才能替换一个原语。宿主的完整记录结构上满足本视图，无需转换。
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

/** 宿主绑定实现（装配阶段一次）。 */
let boundPort: MachineEnvironmentPort | null = null;
/** 用例替换值（浅合并，优先于宿主绑定）。 */
let override: Partial<MachineEnvironmentPort> | null = null;

/** 由 `apps/server` 在启动装配阶段绑定环境读取实现。 */
export function bindMachineEnvironmentPort(port: MachineEnvironmentPort): void {
  if (boundPort && boundPort !== port) {
    throw new Error("MachineEnvironmentPort has already been bound");
  }
  boundPort = port;
}

/** 测试用：清空宿主绑定，让下个用例从干净状态重新绑定。 */
export function resetMachineEnvironmentPortForTest(): void {
  boundPort = null;
}

/**
 * 替换环境读取实现（用例装配用）。
 *
 * 浅合并语义：只传需要替换的原语；传 `null` 恢复为宿主绑定实现。复位统一走
 * `@fenix/resource-machine/server/testing` 登记的 `registerStubResetter`，避免用例之间配置泄漏。
 */
export function setMachineEnvironmentPort(overrides: Partial<MachineEnvironmentPort> | null): void {
  override = overrides ? { ...override, ...overrides } : null;
}

/**
 * 读取当前生效的环境读取实现（用例替换值优先，否则为宿主绑定实现）。
 *
 * 未绑定时显式失败，不静默回退：环境读取是文件与工作区路由的前置校验，回退到一个"永远放行"的默认实现
 * 等于关掉租户隔离。
 */
export function getMachineEnvironmentPort(): MachineEnvironmentPort {
  const getEnvironmentById = override?.getEnvironmentById ?? boundPort?.getEnvironmentById;
  const getOwnedEnvironment = override?.getOwnedEnvironment ?? boundPort?.getOwnedEnvironment;
  if (!getEnvironmentById || !getOwnedEnvironment) {
    throw new Error("MachineEnvironmentPort has not been bound");
  }
  return { getEnvironmentById, getOwnedEnvironment };
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
