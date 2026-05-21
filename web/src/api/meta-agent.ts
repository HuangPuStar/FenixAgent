/**
 * Meta Agent API Client。
 *
 * 对接后端 POST /web/meta-agent/ensure。
 */

import { apiPost } from "./client";

export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
}

export async function ensureMetaAgent(): Promise<EnsureMetaResult> {
  return apiPost<EnsureMetaResult>("/web/meta-agent/ensure", {});
}
