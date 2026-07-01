/**
 * Meta Agent API Client。
 *
 * 对接后端 POST /web/meta-agent/ensure。
 */

import { request } from "./request";

export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
  apiKey?: string;
}

/** 触发 Meta Agent 的 Environment 与 Instance 确保流程 */
export async function ensureMetaAgent(): Promise<EnsureMetaResult> {
  const { success, data, error } = await request<EnsureMetaResult>("/web/meta-agent/ensure", { method: "POST" });
  if (!success || !data) throw new Error(error?.message ?? "Unknown error");
  return data;
}
