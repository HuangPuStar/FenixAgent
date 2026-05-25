import * as z from "zod/v4";

/** POST /v1/environments/bridge — acp-link REST 注册请求体 */
export const BridgeRegistrationRequestSchema = z.object({
  machine_name: z.string().optional(),
  directory: z.string().optional(),
  branch: z.string().optional(),
  git_repo_url: z.string().optional(),
  max_sessions: z.number().int().min(1).optional(),
  worker_type: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  metadata: z.object({ worker_type: z.string().optional() }).optional(),
});

/** POST /v1/environments/bridge 注册响应 */
export const BridgeRegistrationResponseSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  token: z.string().optional(),
  secret: z.string().optional(),
  status: z.string().optional(),
});

export type BridgeRegistrationRequest = z.infer<typeof BridgeRegistrationRequestSchema>;
export type BridgeRegistrationResponse = z.infer<typeof BridgeRegistrationResponseSchema>;
