export interface PoolInput {
  id: string;
  name: string;
  status?: string;
}

export interface ServerInput {
  id: string;
  pool_id: string;
  name: string;
  base_url?: string;
  workspace_root: string;
  api_key: string;
  max_sandboxes: number;
  status?: string;
  transport_mode?: "direct" | "tunnel";
}

export function bodyOf<T>(body: unknown): T {
  if (!body || typeof body !== "object") throw new Error("request body must be an object");
  return body as T;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

export function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${field} must be a positive integer`);
  return value as number;
}
