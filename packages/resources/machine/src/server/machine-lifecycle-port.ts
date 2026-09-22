// machine-lifecycle-port.ts — 本包对「机器生命周期事件」的对外通知端口
//
// 为什么需要这一层：机器注册与机器心跳都会改变**沙盒实例**的可用状态（注册前的实例处于 creating /
// starting / recovering，收到心跳说明实例所在机器活着）。此前本包直接 UPDATE `sandbox_instance`
// 表达这两次投影，`sandbox_instance` 归 `@fenix/resource-sandbox` 后，这条 `machine → sandbox` 的写
// 路径同时命中 §2.3 的类别禁则（组装期例外只覆盖 `packages/**/db/**`，本包写在 `src/server/` 下不适用）
// ——迁表批次无法靠改 import 解决（§1.7 B4 前置的裁定）。
//
// 现在的分工：本包只**通报事件**（「机器 X 在 T 注册 / 心跳」），沙盒在自己的表上完成投影（哪些状态算
// 中间态、心跳写哪一列，都是沙盒的领域知识）。绑定方是消费方向的上游：`sandbox` 依赖 `machine`
// （`dependsOn: ["machine"]`，§2.3 固定方向 sandbox → machine），由沙盒在模块装配时注入，本包不反向依赖。
//
// 与 `host-port.ts` 的语义差别：host port 是宿主必提供的能力，未绑定即失败；本端口**未绑定是正常状态**
// ——assembly profile 可以不含沙盒模块，那时本包静默跳过通知（不含沙盒模块意味着没有实例行，通知本无
// 受体）。反过来，只要沙盒模块被装配（`createSandboxModule()`），本端口必然已绑定，不存在「沙盒在、
// 端口没绑」的中间态。

/** 机器生命周期通知能力；由 `@fenix/resource-sandbox` 在模块装配阶段注入。 */
export interface MachineLifecyclePort {
  /** 机器注册完成（首次注册或重连）后通报；投影由接收方按自己的语义决定。 */
  notifyMachineRegistered(machineId: string, at: Date): Promise<void>;
  /** 收到机器心跳后通报。 */
  notifyMachineHeartbeat(machineId: string, at: Date): Promise<void>;
}

let port: MachineLifecyclePort | null = null;

/** 由 `@fenix/resource-sandbox` 在模块装配阶段注入。 */
export function bindMachineLifecyclePort(next: MachineLifecyclePort): void {
  if (port && port !== next) {
    throw new Error("MachineLifecyclePort has already been bound");
  }
  port = next;
}

/** 读取通知实现；未装配返回 null，调用方按「无沙盒能力」跳过通知。 */
export function getMachineLifecyclePort(): MachineLifecyclePort | null {
  return port;
}

/** 测试用：清空注入，防止测试进程内状态泄漏。 */
export function resetMachineLifecyclePortForTest(): void {
  port = null;
}
