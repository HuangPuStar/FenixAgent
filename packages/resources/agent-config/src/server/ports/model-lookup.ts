/**
 * 模型展示标签的窄端口。
 *
 * 为什么是端口而不是包内取数：`provider` / `model` 两张表归 `@fenix/model-management`（§1.7 B3 已迁出
 * 宿主 schema），本包在调用期既不读它们的表对象（§6.1 的组装期例外只在各包 `db/` 内成立），也不能直接
 * import 该包的公开入口——model-management 的 `dependsOn` 已含 `agent-config`（它解析 Agent 名称），
 * 本包再声明 `model-management` 会在模块装配期闭合 `dependsOn` 二元环，所有 profile 都会因装配顺序
 * 失败。因此取数由宿主在装配阶段注入，与 `MachineLookupPort`、`UserAgentPreferencesPort`、
 * `AgentConfigLookupPort` 同一形状。
 *
 * 键是 model id，值是**已算好的展示标签**（`<Provider 展示名>/<模型展示名>`）：标签怎么拼、哪一段缺失
 * 时回退到 `name` / `model_id`，留在 model-management 的实现里，因为「一个模型怎么显示」是它自己的
 * 词汇，不是本视图的语义。行缺失时不在端口内造值，由调用方决定退回 id 还是置空——「查不到」与
 * 「显示名就是 id」是两种不同的结果。
 */

/** 模型展示标签的只读端口；由宿主装配注入，包内不提供默认实现。 */
export interface ModelLookupPort {
  /** 按 model id 批量取展示标签；空入参返回空 Map，缺失的 id 不出现在结果里。 */
  findModelLabelsByIds(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

let boundPort: ModelLookupPort | null = null;

/** 由宿主装配阶段绑定一次；重复绑定直接报错，避免两个实现并存导致不同调用点读到不同视图。 */
export function bindModelLookupPort(port: ModelLookupPort): void {
  if (boundPort && boundPort !== port) throw new Error("ModelLookupPort has already been bound");
  boundPort = port;
}

/** 取端口；未装配时 fail-fast，不做兜底实现。 */
export function getModelLookupPort(): ModelLookupPort {
  if (!boundPort) throw new Error("ModelLookupPort has not been bound");
  return boundPort;
}

/** 测试用：清空绑定，防止跨测试文件共享状态。 */
export function resetModelLookupPort(): void {
  boundPort = null;
}
