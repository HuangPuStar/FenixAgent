import { bindCoreRuntimePort, type CoreRuntimePort } from "@fenix/agent-runtime/server";
import { getBoundCoreRuntimePort, resetCoreRuntimePortForTest } from "@fenix/agent-runtime/server/testing";
import type { CoreRuntimeFacade } from "@fenix/core";

// 两个入口分取（1.4 W6b）：`bindCoreRuntimePort` / `CoreRuntimePort` 是宿主注入契约，生产面就是它的
// 归属；`getBoundCoreRuntimePort` / `resetCoreRuntimePortForTest` 只对测试有意义，从唯一测试入口取。

/**
 * 包内用例的 Core runtime 端口替身（`@fenix/agent-runtime/server` 的 `bindCoreRuntimePort`）。
 *
 * **为什么走端口**：Core runtime 由宿主进程唯一持有（`apps/server/src/main.ts` 装配期绑定
 * `bindCoreRuntimePort`），资源包不得 import `@server/services/core-bootstrap`。迁移前 workflow 用例
 * 经宿主 preload 的 `stubCoreBootstrap` 配置宿主注册表，正是本任务要切断的宿主依赖（review §6.2：
 * 该替身归 agent-runtime 的 `/server/testing`，本包只消费已发布的端口）。
 *
 * **为什么先复位再绑定、用完还原**：`bindCoreRuntimePort` 对「已绑定另一个 port」抛错，而根目录
 * `bun test` 会先执行宿主 preload（`apps/server/src/test-utils/setup-mocks.ts` 已绑定转发到宿主替身
 * 注册表的 port）。bun 的测试进程在同一次运行内被复用，因此这里保存当前绑定 → 复位 → 绑定替身，
 * 用例结束后还原：留下替身会让后续测试文件看到空的 `registerRemoteNode` / `unregisterRemoteNode`
 * 而静默失真。包目录内单跑（根 bunfig 的 preload 不生效）时无绑定可还原，`savedPort` 留空。
 */

let savedPort: CoreRuntimePort | null = null;

/**
 * 绑定「只提供给定 facade」的最小端口替身。
 *
 * 远端节点注册为空操作：包内用例不覆盖机器注册面（那是 agent-runtime 与 machine 的验收范围），
 * 未注册的替身函数比「返回 undefined 后由调用方 TypeError」更容易定位。
 */
export function bindStubCoreRuntime(facade: CoreRuntimeFacade): void {
  try {
    savedPort = getBoundCoreRuntimePort();
  } catch {
    savedPort = null;
  }
  resetCoreRuntimePortForTest();
  bindCoreRuntimePort({
    getCoreRuntime: () => facade,
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
