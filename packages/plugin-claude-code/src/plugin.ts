import type { EnginePlugin } from "@fenix/plugin-sdk";
import { createClaudeCodeRuntime } from "./runtime/claude-code-runtime.js";

export interface ClaudeCodePluginOptions {
  /** workspace 根目录，宿主本地执行装配点注入（`getAgentRuntimeConfig().workspaceRoot`）。 */
  workspaceRoot?: string;
}

/**
 * 创建 claude-code engine plugin 的唯一公开入口。
 */
export function createClaudeCodePlugin(options: ClaudeCodePluginOptions = {}): EnginePlugin {
  return {
    meta: {
      id: "claude-code",
      displayName: "Claude Code Engine",
      version: "0.1.0",
    },
    createRuntime() {
      return createClaudeCodeRuntime({ workspaceRoot: options.workspaceRoot });
    },
  };
}
