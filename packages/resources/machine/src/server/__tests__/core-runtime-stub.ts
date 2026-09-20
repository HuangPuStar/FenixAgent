import {
  bindCoreRuntimePort,
  type CoreRuntimePort,
  getBoundCoreRuntimePort,
  resetCoreRuntimePortForTest,
} from "@fenix/agent-runtime/server";

/**
 * 包内用例的 Core runtime 端口替身（`@fenix/agent-runtime/server` 的 `bindCoreRuntimePort`）。
 *
 * **为什么走端口**：Core runtime 由宿主进程唯一持有（`apps/server/src/main.ts` 装配期绑定端口），资源包不得
 * import `@server/services/core-bootstrap`。迁移前本包用例经宿主 preload 的 `stubCoreBootstrap` 配置宿主注册表，
 * 正是本任务要切断的宿主依赖（review §6.2：该替身归 agent-runtime 的 `/server/testing`，本包只消费已发布的
 * 端口；`@fenix/resource-workflow` 的同名替身是本仓先例）。
 *
 * **为什么先复位再绑定、用完还原**：`bindCoreRuntimePort` 对「已绑定另一个端口」抛错，而根目录 `bun test`
 * 会先执行宿主 preload（`apps/server/src/test-utils/setup-mocks.ts` 已绑定转发到宿主替身注册表的端口）。bun
 * 的测试进程在同一次运行内被复用，因此这里保存当前绑定 → 复位 → 绑定替身，用例结束后还原：留下替身会让后续
 * 测试文件看到空的 `registerRemoteNode` / `unregisterRemoteNode` 而静默失真。
 *
 * **只实现本包读到的成员**：本包经 `getBoundCoreRuntime()?.getNode(machineId)` 做 register 身份对账（§7.1），
 * 其余 facade 成员在包内没有调用点；远端节点注册实现为空操作——包内用例不覆盖机器注册面（那是 agent-runtime
 * 与 machine 的验收范围），空实现比「返回 undefined 后由调用方 TypeError」更容易定位。
 */

/** 传入 `null` 表示「端口已绑定但未提供 facade」：对账查询因此拿到 `undefined`（宽松分支的输入）。 */
type NodeLookupFacade = { getNode(machineId: string): unknown } | null;

let savedPort: CoreRuntimePort | null = null;

/** 绑定只提供给定 facade 的最小端口替身（`null` 表示无 facade）。 */
export function bindStubCoreRuntime(facade: NodeLookupFacade): void {
  try {
    savedPort = getBoundCoreRuntimePort();
  } catch {
    savedPort = null;
  }
  resetCoreRuntimePortForTest();
  bindCoreRuntimePort({
    // 结构断言：`CoreRuntimeFacade` 有 `getNode(nodeId): CoreNode | null`，可赋给本替身的窄视图；
    // 反向不成立，故本包不复制 facade 的成员表（多出来的成员在包内没有调用点）。
    getCoreRuntime: () => facade as ReturnType<CoreRuntimePort["getCoreRuntime"]>,
    registerRemoteNode: () => {},
    unregisterRemoteNode: () => {},
  });
}

/** 还原绑定前的端口（用例 `afterEach` 调用），避免替身泄漏到同进程的后续测试文件。 */
export function restoreCoreRuntimePort(): void {
  resetCoreRuntimePortForTest();
  if (savedPort) bindCoreRuntimePort(savedPort);
  savedPort = null;
}
