import { setMachineHostPort } from "../host-port";

/**
 * 包内用例的 Core runtime 节点查询替身（`MachineHostPort.getCoreRuntimeNode`）。
 *
 * **为什么走端口**：Core runtime 单例由宿主进程唯一持有（`apps/server/src/main.ts` 装配期
 * `bindMachineHostPort`），资源包不得 import `@server/services/core-bootstrap`。迁移前本包用例经宿主 preload
 * 的 `stubCoreBootstrap` 配置宿主注册表，正是本任务要切断的宿主依赖（review §6.2：该替身归宿主，本包只
 * 消费已绑定的端口）。
 *
 * **为什么只替换一个原语**：`file-ws-identity` 只覆盖 register 对账面（`getCoreRuntimeNode` 的返回值决定
 * 放行 / 4404），端口其余四个原语（workspace 路径、远端节点注销、连接索引、断连清理）在该用例组里没有断言点，
 * 继续走宿主 preload 的真实绑定。浅合并让替换面精确等于断言面，不必伪造整份端口。
 *
 * **复位**：替换值由 `@fenix/resource-machine/server/testing` 的 `registerStubResetter` 统一清空，宿主 preload
 * 的绑定不受影响，用例无需自行保存 / 还原。
 */

/** 传入 `null` 表示「对账面没有 facade」：查节点一律返回 null（宽松放行与严格拒绝两个分支的输入）。 */
type NodeLookupFacade = { getNode(machineId: string): object | null | undefined } | null;

/** 替换对账面的节点查询（`null` 表示查无此机）。 */
export function stubCoreRuntimeNode(facade: NodeLookupFacade): void {
  setMachineHostPort({ getCoreRuntimeNode: (machineId) => facade?.getNode(machineId) ?? null });
}

/**
 * 清空宿主端口的替换层，恢复 preload 绑定实现。
 *
 * 浅合并语义下无法只删一个原语，故整层清空；`resetAllStubs()` 也会走到同一结果。
 */
export function resetMachineHostPortStub(): void {
  setMachineHostPort(null);
}
