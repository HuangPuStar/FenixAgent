import { createLogger, error as logError } from "@fenix/logger";

const logger = createLogger("litellm");

let _adminKey: string | null = null;
let _baseUrl: string | null = null;

export function initLitellmClient(config: { adminKey: string; baseUrl: string }): void {
  _adminKey = config.adminKey;
  _baseUrl = config.baseUrl;
}

export function getLitellmClient(): { adminKey: string; baseUrl: string } {
  if (!_adminKey || !_baseUrl) {
    throw new Error("LiteLLM client not initialized. Call initLitellmClient() first.");
  }
  return { adminKey: _adminKey, baseUrl: _baseUrl };
}

export async function litellmRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { adminKey, baseUrl } = getLitellmClient();
  const url = `${baseUrl}${path}`;

  logger.debug(`[LiteLLM] ${method} ${path}`, body ? JSON.stringify(body).slice(0, 200) : "");

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${adminKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    logError(`[LiteLLM] ${method} ${path} HTTP ${response.status}: ${text.slice(0, 500)}`);
    throw new Error(`LiteLLM API HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

/** 检查 LiteLLM 客户端是否已通过 initLitellmClient() 初始化 */
export function isLitellmConfigured(): boolean {
  return !!(_adminKey && _baseUrl);
}
