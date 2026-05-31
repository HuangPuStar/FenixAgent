export { createEnginePlugin } from "./plugin";
export type { PreparedWorkspacePaths } from "./runtime/environment-preparer";
export { ensureWorkspaceRuntimeDirs, writeOpencodeConfig } from "./runtime/environment-preparer";
export type { OpencodeRuntime, OpencodeRuntimeDependencies } from "./runtime/opencode-runtime";
export { createOpencodeRuntime } from "./runtime/opencode-runtime";
export type { InstalledSkillReference, OpencodeRuntimeConfig } from "./runtime/runtime-config";
// 环境装配函数：供 acp-link 远程端复用
export { buildOpencodeRuntimeConfig } from "./runtime/runtime-config";
export { installSkills } from "./runtime/skill-installer";
