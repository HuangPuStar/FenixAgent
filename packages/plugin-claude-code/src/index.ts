// Engine plugin

// Engine handler（供 InstanceManager 调度）
export { createClaudeCodeHandler } from "./claude-code-handler.js";
export { createClaudeCodePlugin } from "./plugin.js";
export { createClaudeCodeRuntime } from "./runtime/claude-code-runtime.js";
export type { PreparedWorkspacePaths } from "./runtime/environment.js";
export {
  ensureWorkspaceRuntimeDirs,
  prepareWorkspaceEnvironment,
  writeClaudeMd,
  writeMcpConfig,
  writeSettings,
} from "./runtime/environment.js";
export type {
  ClaudeCodeMcpConfig,
  ClaudeCodeMcpRemoteConfig,
  ClaudeCodeMcpServerConfig,
  ClaudeCodeMcpStdioConfig,
  ClaudeCodeSettings,
  InstalledSkillReference,
} from "./runtime/settings.js";
export { buildMcpConfig, buildSettings } from "./runtime/settings.js";
// Workspace preparation utilities（供 instance-manager 等使用）
export { installSkills } from "./runtime/skill-installer.js";
