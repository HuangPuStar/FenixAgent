/**
 * `@fenix/plugin-sdk` 的公共导出面。
 */
export type {
  AgentConfig,
  AgentLaunchSpec,
  McpOAuthConfig,
  McpServerConfig,
  ModelConfig,
  SkillConfig,
  StdioMcpServerConfig,
  StreamableHttpMcpServerConfig,
  WorkspaceFile,
} from "./agent-launch-spec";
export type {
  ConnectRelayInput,
  EnginePlugin,
  EnginePluginMeta,
  EngineRuntime,
  PrepareEnvironmentInput,
  StartInstanceInput,
  StopInstanceInput,
} from "./engine-plugin";
export type {
  EngineHealthStatus,
  EngineRelayHandle,
  EngineRelayMessage,
  EngineRelayState,
  EngineSessionSummary,
} from "./engine-relay";
export { bindWorkspaceFiles, writeWorkspaceFiles } from "./workspace-files";
