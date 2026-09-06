import { agentKnowledgeBindingRepo, knowledgeBaseRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";

/**
 * 清除测试直接写在 repository class instance 上的方法覆盖，使调用重新落回原型实现。
 * 仅删除确实遮蔽原型方法的 own property，不修改 repository 的实例数据。
 */
export function resetKnowledgeRepositoryMethodOverrides(): void {
  for (const repository of [knowledgeBaseRepo, knowledgeResourceRepo, agentKnowledgeBindingRepo]) {
    const prototype = Object.getPrototypeOf(repository) as object | null;
    if (!prototype) continue;

    for (const key of Reflect.ownKeys(repository)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (typeof descriptor?.value !== "function") continue;
      if (!Reflect.deleteProperty(repository, key)) {
        throw new Error(`Failed to restore repository method: ${String(key)}`);
      }
    }
  }
}
