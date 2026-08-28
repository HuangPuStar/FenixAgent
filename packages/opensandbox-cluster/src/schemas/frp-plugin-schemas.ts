export type FrpPluginOperation = "Login" | "NewProxy" | "Ping" | "CloseProxy";

export interface FrpPluginRequest {
  op: string;
  content?: Record<string, unknown>;
}

export interface FrpPluginMetadata {
  serverId: string;
  nodeToken: string;
  runId?: string;
}

export type PluginResponse =
  | { reject: false; unchange: true }
  | { reject: true; reject_reason: string; unchange: true };
