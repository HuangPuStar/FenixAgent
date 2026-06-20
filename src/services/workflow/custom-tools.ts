/**
 * 自定义节点（CustomNode）工具注册表单例。
 *
 * 服务启动时调用 `initCustomToolsRegistry()` 一次，扫描 WORKFLOW_TOOLS_DIR 目录下
 * 所有 .ts 文件，实例化默认导出的 SlurmNode/CustomNode 子类并注册到全局 registry。
 *
 * 后续 `getCustomToolsRegistry()` 同步获取已初始化的 registry，注入到每个 team 的
 * WorkflowEngine 实例。tools 目录不存在或为空时返回空 registry（不抛错，前端可见空列表）。
 */

import path from "node:path";
import { createLogger } from "@fenix/logger";
import { CustomNodeRegistry } from "@fenix/workflow-engine";

const logger = createLogger("workflow-tools");

let _registry: CustomNodeRegistry | null = null;
let _initPromise: Promise<CustomNodeRegistry> | null = null;

/**
 * 启动时扫描工具目录并初始化 registry。
 * 幂等：多次调用返回同一个 Promise，registry 仅构建一次。
 */
export async function initCustomToolsRegistry(toolsDir?: string): Promise<CustomNodeRegistry> {
  if (_registry) return _registry;
  if (_initPromise) return _initPromise;

  const dir = toolsDir ?? process.env.WORKFLOW_TOOLS_DIR ?? path.resolve(process.cwd(), "tools");
  logger.info("Discovering custom tools", { dir });

  _initPromise = CustomNodeRegistry.discover(dir)
    .then((registry) => {
      _registry = registry;
      // list() 返回值只包含 name/description/inputs/produces，足够观测
      const tools = registry.list();
      logger.info("Custom tools registry ready", { count: tools.length, names: tools.map((t) => t.name) });
      return registry;
    })
    .catch((err) => {
      // discover 失败不应阻塞服务启动：fallback 到空 registry，前端可见空工具列表
      logger.error(
        "Failed to discover custom tools, fallback to empty registry",
        err instanceof Error ? err : undefined,
        {
          dir,
        },
      );
      _registry = new CustomNodeRegistry();
      return _registry;
    })
    .finally(() => {
      _initPromise = null;
    });

  return _initPromise;
}

/**
 * 同步获取已初始化的 registry。
 *
 * 必须在 `initCustomToolsRegistry()` 完成后调用。
 * 若未初始化（开发态忘调 init），返回空 registry 并 warn，避免阻塞 engine 创建。
 */
export function getCustomToolsRegistry(): CustomNodeRegistry {
  if (!_registry) {
    logger.warn("Custom tools registry accessed before init, returning empty registry");
    _registry = new CustomNodeRegistry();
  }
  return _registry;
}
