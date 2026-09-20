// sandbox-route-port.ts — 本包对「环境该路由到哪台机器」的沙盒判定端口
//
// 为什么需要这一层：资源文件服务要回答「这个环境的文件请求发往哪台机器」，其中沙盒分支的答案是
// 「节点声明的池 / 默认池里有没有该用户的活跃实例」——读的是沙盒自己的模块配置与池、实例表。
// 此前由本包反向查询（台账 `special-dependency` 与 `no-circular`，owner 1.4），改为沙盒主动注入后
// 该反向边消除。
//
// 为什么由 sandbox 绑定而不是宿主：判定方就是 sandbox 自己，绑定方应是消费方向的上游。
// `sandbox` 依赖 `machine`（`dependsOn: ["machine"]`，§2.3 固定方向 sandbox → machine），
// 由 sandbox 在模块装配时注入，本包不反向依赖。
//
// 与 `host-port.ts` 的语义差别：host port 是宿主必提供的能力，未绑定即失败；本端口**未绑定是正常状态**
// ——assembly profile 可以不含沙盒模块，那时本包按「无沙盒路由」降级，不抛错。

/** 沙盒路由判定的输入。 */
export interface SandboxRouteInput {
  /** AgentNode 显式声明的沙盒池 ID；非沙盒节点为 null。 */
  readonly explicitSandboxPoolId: string | null;
  /** AgentNode 是否显式绑定到某台机器；为 true 时不走沙盒。 */
  readonly boundToMachine: boolean;
  readonly organizationId: string;
  /** 环境属主；为空表示没有可查询的主体，判定方据此跳过实例查询。 */
  readonly userId: string;
}

/** 沙盒路由判定的结果。 */
export interface SandboxRouteResult {
  /** 是否命中沙盒模式。为 true 时调用方**不得**回落到默认机器——回落会让沙盒环境静默跑到别的机器上。 */
  readonly sandboxSelected: boolean;
  /** 命中沙盒且有活跃实例时为其所在机器；否则 null。 */
  readonly machineId: string | null;
}

/** 沙盒路由判定能力。 */
export interface MachineSandboxRoutePort {
  resolveSandboxRoute(input: SandboxRouteInput): Promise<SandboxRouteResult>;
}

let port: MachineSandboxRoutePort | null = null;

/** 由 `@fenix/resource-sandbox` 在模块装配阶段注入。 */
export function bindMachineSandboxRoutePort(next: MachineSandboxRoutePort): void {
  if (port && port !== next) {
    throw new Error("MachineSandboxRoutePort has already been bound");
  }
  port = next;
}

/** 读取沙盒路由实现；未装配返回 null，调用方按「无沙盒能力」降级。 */
export function getMachineSandboxRoutePort(): MachineSandboxRoutePort | null {
  return port;
}

/** 测试用：清空注入，防止测试进程内状态泄漏。 */
export function resetMachineSandboxRoutePortForTest(): void {
  port = null;
}
