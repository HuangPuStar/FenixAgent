/**
 * Meta Agent API Client。
 *
 * 对接后端 POST /web/meta-agent/ensure。
 */

import { metaAgentApi } from "./sdk";

export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
}

export async function ensureMetaAgent(): Promise<EnsureMetaResult> {
  const { data, error } = await metaAgentApi.ensure();
  if (error) throw new Error(error.message);
  return data as unknown as EnsureMetaResult;
}
