// src/services/environment.ts — barrel re-export
// 所有导出名称保持不变，下游 import 路径无需修改。

// ── web ──
export {
  createWebEnvironment,
  listEnvironmentsWithInstances,
  updateWebEnvironment,
} from "../server/services/environment-web";
// ── acp ──
export {
  createTemporaryEnvironment,
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
  reconnectEnvironment,
  registerEnvironment,
  touchEnvironmentPoll,
  updateEnvironmentCapabilities,
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
