/**
 * 机器展示标签的窄端口（Agent 执行节点标签）。
 *
 * 为什么是端口而不是包内取数：`machine` 表归 `@fenix/resource-machine`（§1.7 B1 已迁出宿主 schema），
 * 本包在调用期既不读它的表对象（§6.1 的组装期例外只在各包 `db/` 内成立），也不能直接 import 该包的公开
 * 入口——machine 的 `dependsOn` 已含 `agent-config`（它解析 AgentNode），本包再声明 `machine` 会在模块
 * 装配期闭合 `dependsOn` 二元环，所有 profile 都会因装配顺序失败。因此取数由宿主在装配阶段注入，
 * 与 `UserAgentPreferencesPort`、`AgentConfigLookupPort` 同一形状。
 *
 * 键是 machine id，值是**已算好的展示标签**：标签回退链（人工命名 → 主机名 → Agent 名）留在这个包的
 * 实现里，因为「一台机器怎么显示」是 machine 自己的词汇，不是本视图的语义。行缺失时不在端口内造值，
 * 由调用方决定退回 id 还是置空——「查不到」与「显示名就是 id」是两种不同的结果。
 */

/** 机器展示标签的只读端口；由宿主装配注入，包内不提供默认实现。 */
export interface MachineLookupPort {
  /** 按 machine id 批量取展示标签；空入参返回空 Map，缺失的 id 不出现在结果里。 */
  findMachineLabelsByIds(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

let boundPort: MachineLookupPort | null = null;

/** 由宿主装配阶段绑定一次；重复绑定直接报错，避免两个实现并存导致不同调用点读到不同视图。 */
export function bindMachineLookupPort(port: MachineLookupPort): void {
  if (boundPort && boundPort !== port) throw new Error("MachineLookupPort has already been bound");
  boundPort = port;
}

/** 取端口；未装配时 fail-fast，不做兜底实现。 */
export function getMachineLookupPort(): MachineLookupPort {
  if (!boundPort) throw new Error("MachineLookupPort has not been bound");
  return boundPort;
}

/** 测试用：清空绑定，防止跨测试文件共享状态。 */
export function resetMachineLookupPort(): void {
  boundPort = null;
}
