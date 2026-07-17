import { litellmRequest } from "./client";

export interface GenerateKeyParams {
  user_id: string;
  agent_id: string;
  organization_id: string;
  key_alias: string;
  metadata?: Record<string, string>;
  tags: string[];
  max_budget: number;
  budget_duration: string;
  models: string[];
}

export interface GenerateKeyResult {
  key: string;
  key_name: string;
  token?: string;
  key_id?: string;
}

export async function generateLitellmKey(params: GenerateKeyParams): Promise<GenerateKeyResult> {
  return litellmRequest<GenerateKeyResult>("POST", "/key/generate", {
    user_id: params.user_id,
    agent_id: params.agent_id,
    organization_id: params.organization_id,
    key_alias: params.key_alias,
    metadata: params.metadata ?? {},
    tags: params.tags,
    max_budget: params.max_budget,
    budget_duration: params.budget_duration,
    models: params.models,
  });
}

export interface KeyInfo {
  key: string;
  key_name: string;
  key_alias?: string;
  spend: number;
  max_budget?: number;
  expires?: string;
  models: string[];
  metadata?: Record<string, unknown>;
  user_id?: string;
  agent_id?: string;
}

export async function getLitellmKeyInfo(keyOrId: string): Promise<KeyInfo> {
  return litellmRequest<KeyInfo>("GET", `/key/info?key=${keyOrId}`);
}

export async function deleteLitellmKeys(keyIds: string[]): Promise<void> {
  await litellmRequest("POST", "/key/delete", { keys: keyIds });
}
