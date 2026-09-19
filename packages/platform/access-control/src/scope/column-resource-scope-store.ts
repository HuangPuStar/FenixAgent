import type { ResourceScope, ResourceScopeStore, ResourceStorageBinding } from "@fenix/platform-sdk";
import { eq, inArray } from "drizzle-orm";
import { type AccessControlDatabase, isMissingScopeStoreBinding } from "../database";
import { type ResolvedScopeColumns, resolveScopeColumns, scopeOfRow } from "./scope-columns";

/**
 * CE 的 `ResourceScopeStore`：范围直接落在资源主表的归属列上。
 *
 * 主表列是唯一真相（设计 §2.3/§4），因此不存在独立的范围行：
 * - 归属列（组织、owner）在资源创建时随行写入，本 Store 不负责写它们；
 * - `visibility` 是资源自身的字段，可经 {@link update} 改写；
 * - 资源行删除即范围消失，`remove` 因此没有额外动作。
 *
 * EE 若需要集中治理或不同范围模型，替换本实现即可，资源 Facade 与领域逻辑不变。
 */
export class ColumnResourceScopeStore implements ResourceScopeStore {
  private readonly bindings = new Map<string, ResolvedScopeColumns>();

  constructor(
    private readonly database: AccessControlDatabase,
    bindings: readonly ResourceStorageBinding[],
  ) {
    for (const binding of bindings) {
      this.bindings.set(binding.resourceType, resolveScopeColumns(binding));
    }
  }

  /** CE 的归属列随资源行 INSERT 写入，不存在"先建行再初始化范围"的路径。 */
  async initialize(): Promise<void> {
    throw new Error("CE 的归属列随资源行写入，不存在独立的 ResourceScopeStore.initialize 路径");
  }

  async getMany(input: { resourceType: string; resourceIds: readonly string[] }): Promise<Map<string, ResourceScope>> {
    const resolved = this.requireBinding(input.resourceType);
    if (input.resourceIds.length === 0) return new Map();
    const rows: Record<string, unknown>[] = await this.database
      .select()
      .from(resolved.table)
      .where(inArray(resolved.id, [...input.resourceIds]));
    return new Map(rows.map((row) => [row[resolved.rowKeys.id] as string, scopeOfRow(resolved, row)]));
  }

  /**
   * 写入 `visibility`。
   *
   * 只写公开受众：归属列是资源的创建期属性，不属于范围更新路径——冲突更新改归属会让资源在
   * 组织之间漂移，且不对应任何 Facade 动作。
   */
  async update(input: { resourceType: string; resourceId: string; scope: ResourceScope }): Promise<void> {
    const resolved = this.requireBinding(input.resourceType);
    if (resolved.visibility === undefined || resolved.rowKeys.visibility === undefined) {
      throw new Error(`资源 ${input.resourceType} 未声明 visibility 列，无法更新公开受众`);
    }
    await this.database
      .update(resolved.table)
      .set({ [resolved.rowKeys.visibility]: input.scope.visibility })
      .where(eq(resolved.id, input.resourceId));
  }

  /** 范围随主表行删除，没有独立记录需要清理。 */
  async remove(input: { resourceType: string; resourceId: string }): Promise<void> {
    this.requireBinding(input.resourceType);
  }

  private requireBinding(resourceType: string): ResolvedScopeColumns {
    const resolved = this.bindings.get(resourceType);
    if (!resolved) throw isMissingScopeStoreBinding(resourceType);
    return resolved;
  }
}
