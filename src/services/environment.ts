// src/services/environment.ts — barrel re-export
// 所有导出名称保持不变，下游 import 路径无需修改。

export type {
  BridgeRegistrationInput,
  BridgeRegistrationResult,
} from "./environment-acp";
// ── acp ──
export {
  createTemporaryEnvironment,
  deregisterBridge,
  deregisterEnvironment,
  getEnvironment,
  getEnvironmentBySecret,
  handleAcpConnect,
  handleAcpDisconnect,
  handleAcpIdentify,
  handleAcpRegister,
  listActiveEnvironments,
  listActiveEnvironmentsByUsername,
  listActiveEnvironmentsResponse,
  markEnvironmentActive,
  markEnvironmentIdle,
  reconnectBridge,
  reconnectEnvironment,
  registerBridge,
  registerEnvironment,
  touchEnvironmentPoll,
  updateEnvironmentCapabilities,
  updatePollTime,
} from "./environment-acp";
export type {
  CreateWebEnvironmentParams,
  UpdateWebEnvironmentParams,
} from "./environment-core";
// ── core ──
export {
  deleteEnvironment,
  ensureWorkspaceDir,
  generateEnvSecret,
  getOwnedEnvironment,
  KEBAB_CASE_RE,
  sanitizeResponse,
  toResponse,
  validateWorkspacePath,
} from "./environment-core";
// ── web ──
export {
  createWebEnvironment,
  listEnvironmentsWithInstances,
  updateWebEnvironment,
} from "./environment-web";
