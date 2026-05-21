/**
 * Meta Agent API Client。
 *
 * 对接后端 POST /web/meta-agent/ensure。
 */

import { client, unwrapEden } from "./client";

export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
}

export async function ensureMetaAgent(): Promise<EnsureMetaResult> {
  const res = await client.web.metaAgent.ensure.post({});
  return unwrapEden<EnsureMetaResult>(res);
}
