import type { EnginePlugin } from "@fenix/plugin-sdk";
import { createClaudeCodeRuntime } from "./runtime/claude-code-runtime.js";

/**
 * 创建 claude-code engine plugin 的唯一公开入口。
 */
export function createClaudeCodePlugin(): EnginePlugin {
  return {
    meta: {
      id: "claude-code",
      displayName: "Claude Code Engine",
      version: "0.1.0",
    },
    createRuntime() {
      return createClaudeCodeRuntime();
    },
  };
}
