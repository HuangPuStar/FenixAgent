/**
 * CustomNodeRegistry — 自定义工具注册表。
 *
 * 全局单例，服务启动时调用 discover() 扫描 tools/ 目录一次。
 * per-run 复用同一实例，不热加载、不存 DB。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CustomNode, InputDef } from "./types";

export class CustomNodeRegistry {
  private tools: Map<string, CustomNode> = new Map();

  /** 启动时扫描 tools/ 目录，实例化所有工具 */
  static async discover(toolsDir: string): Promise<CustomNodeRegistry> {
    const registry = new CustomNodeRegistry();

    if (!fs.existsSync(toolsDir) || !fs.statSync(toolsDir).isDirectory()) {
      console.warn(`[CustomNodeRegistry] tools directory not found: ${toolsDir}`);
      return registry;
    }

    const entries = fs.readdirSync(toolsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;

      const fullPath = path.resolve(toolsDir, entry);
      try {
        const module = await import(fullPath);
        const ToolClass = module.default;

        if (typeof ToolClass !== "function") {
          console.warn(`[CustomNodeRegistry] skipping ${entry}: default export is not a class`);
          continue;
        }

        const instance = new ToolClass();

        if (!instance.name || typeof instance.name !== "string") {
          console.warn(`[CustomNodeRegistry] skipping ${entry}: missing 'name' property`);
          continue;
        }
        if (typeof instance.execute !== "function") {
          console.warn(`[CustomNodeRegistry] skipping ${entry}: missing 'execute' method`);
          continue;
        }

        registry.register(instance);
        console.log(`[CustomNodeRegistry] registered tool: ${instance.name} (from ${entry})`);
      } catch (err) {
        console.warn(`[CustomNodeRegistry] failed to load ${entry}:`, err);
      }
    }

    return registry;
  }

  /** 按名称查找工具 */
  get(name: string): CustomNode | undefined {
    return this.tools.get(name);
  }

  /** 列出所有已注册工具（供前端 API） */
  list(): Array<{
    name: string;
    description: string;
    inputs: Record<string, InputDef>;
    produces: string[];
    kind?: string;
    color?: string;
    env?: string[];
  }> {
    const result: Array<{
      name: string;
      description: string;
      inputs: Record<string, InputDef>;
      produces: string[];
      kind?: string;
      color?: string;
      env?: string[];
    }> = [];
    for (const tool of this.tools.values()) {
      result.push({
        name: tool.name,
        description: tool.description,
        inputs: tool.inputs,
        produces: tool.produces,
        kind: tool.kind,
        color: tool.color,
        env: tool.env,
      });
    }
    return result;
  }

  /** 手动注册一个工具（测试用） */
  register(tool: CustomNode): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`[CustomNodeRegistry] tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }
}
