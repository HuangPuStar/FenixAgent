import { litellmRequest } from "./client";

export interface SpendLogEntry {
  request_id: string;
  api_key?: string;
  model: string;
  spend: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  startTime: string;
  endTime: string;
  user?: string;
  metadata?: Record<string, unknown>;
}

export interface SpendLogsResponse {
  data: SpendLogEntry[];
  total: number;
  page: number;
  page_size: number;
}

export async function getSpendLogs(params: {
  api_key?: string;
  start_date?: string;
  end_date?: string;
  page?: number;
  page_size?: number;
}): Promise<SpendLogsResponse> {
  const query = new URLSearchParams();
  if (params.api_key) query.set("api_key", params.api_key);
  if (params.start_date) query.set("start_date", params.start_date);
  if (params.end_date) query.set("end_date", params.end_date);
  if (params.page) query.set("page", String(params.page));
  if (params.page_size) query.set("page_size", String(params.page_size));
  return litellmRequest<SpendLogsResponse>("GET", `/spend/logs?${query.toString()}`);
}

export async function getSpendByTags(tags: string[]): Promise<{ [tag: string]: { spend: number } }> {
  return litellmRequest("GET", `/global/spend/tags?tags=${tags.join(",")}`);
}
