import type { EnginePlugin } from "@mothership/plugin-sdk";
import { CoreRuntimeError, createCoreRuntimeError } from "../errors/core-runtime-error";

/**
 * Engine plugin 注册表的只读访问面。
 */
export interface ReadonlyEnginePluginRegistry {
  /** 按 engine type 查询插件；不存在时返回 `null`。 */
  get(engineType: string): EnginePlugin | null;
  /** 按 engine type 查询插件；不存在时抛出具名错误。 */
  require(engineType: string): EnginePlugin;
  /** 返回按注册顺序排列的全部插件。 */
  list(): EnginePlugin[];
  /** 判断某个 engine type 是否已注册。 */
  has(engineType: string): boolean;
}

/**
 * 基于 `plugin.meta.id` 管理 engine plugin 定义。
 */
export class EnginePluginRegistry implements ReadonlyEnginePluginRegistry {
  private readonly plugins = new Map<string, EnginePlugin>();

  /**
   * 注册一个 engine plugin，并返回原始 plugin 便于链式装配。
   */
  register(plugin: EnginePlugin): EnginePlugin {
    const engineType = plugin.meta.id;

    if (this.plugins.has(engineType)) {
      throw createCoreRuntimeError("DUPLICATE_ENGINE_PLUGIN", `Engine plugin already registered: ${engineType}`, {
        engineType,
      });
    }

    this.plugins.set(engineType, plugin);
    return plugin;
  }

  /**
   * 按 engine type 查询插件定义。
   */
  get(engineType: string): EnginePlugin | null {
    return this.plugins.get(engineType) ?? null;
  }

  /**
   * 按 engine type 查询插件定义，不存在则抛错。
   */
  require(engineType: string): EnginePlugin {
    const plugin = this.get(engineType);

    if (!plugin) {
      throw createCoreRuntimeError("PLUGIN_NOT_FOUND", `Engine plugin not found: ${engineType}`, { engineType });
    }

    return plugin;
  }

  /**
   * 返回按注册顺序排列的插件列表副本。
   */
  list(): EnginePlugin[] {
    return [...this.plugins.values()];
  }

  /**
   * 判断某个 engine type 是否已注册。
   */
  has(engineType: string): boolean {
    return this.plugins.has(engineType);
  }
}

export { CoreRuntimeError };
