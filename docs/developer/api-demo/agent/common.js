import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

/**
 * 读取 demo 运行所需的公共配置。
 * 这里集中处理环境变量，其他脚本只依赖 config，避免每个 demo 自己散落一套读取逻辑。
 */
export function getDemoConfig() {
  const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const apiKey = process.env.API_KEY ?? "";

  return {
    baseUrl,
    apiKey,
    agentConfigId: process.env.AGENT_CONFIG_ID ?? "",
    modelId: process.env.MODEL_ID ?? "",
    environmentId: process.env.ENVIRONMENT_ID ?? "",
    sessionId: process.env.SESSION_ID ?? "",
    sessionCwd: process.env.SESSION_CWD ?? "",
    prompt: process.env.PROMPT ?? "请简单介绍一下你自己，并说明你当前能做什么。",
    uploadPath: process.env.UPLOAD_PATH ?? "demo",
    uploadFile: process.env.UPLOAD_FILE ?? "demo-upload.txt",
    autoApprove: process.env.ACP_AUTO_APPROVE === "1",
  };
}

/**
 * 校验必须的环境变量，缺失时给出可执行报错。
 */
export function requireValue(name, value) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`Missing required config: ${name}`);
}

/**
 * 输出清晰的阶段标题，便于观察 demo 执行过程。
 */
export function logSection(title) {
  console.log(`\n=== ${title} ===`);
}

/**
 * 将相对 API 路径解析成完整 URL。
 */
export function toAbsoluteUrl(baseUrl, path) {
  if (/^https?:\/\//.test(path) || /^wss?:\/\//.test(path)) {
    return path;
  }
  return new URL(path, `${baseUrl}/`).toString();
}

/**
 * 将 relay 返回的相对路径转换为 WebSocket URL。
 */
export function toWebSocketUrl(baseUrl, relayPath) {
  const absolute = new URL(relayPath, `${baseUrl}/`);
  absolute.protocol = absolute.protocol === "https:" ? "wss:" : "ws:";
  return absolute.toString();
}

/**
 * 创建带 Bearer Token 的简单 API 客户端。
 */
export function createApiClient(config = getDemoConfig()) {
  return {
    async request(path, init = {}) {
      // API client 层统一补 Authorization，具体 demo 只需要关心接口本身。
      const apiKey = requireValue("API_KEY", config.apiKey);
      const headers = new Headers(init.headers ?? {});
      headers.set("Authorization", `Bearer ${apiKey}`);

      const response = await fetch(toAbsoluteUrl(config.baseUrl, path), {
        ...init,
        headers,
      });

      const rawText = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const data = contentType.includes("application/json") && rawText ? JSON.parse(rawText) : rawText;

      if (!response.ok) {
        const message =
          typeof data === "object" && data && "error" in data
            ? (data.error?.message ?? JSON.stringify(data))
            : rawText || response.statusText;
        throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${message}`);
      }

      return data;
    },
  };
}

/**
 * 读取本地文件并包装成可直接上传的 File 对象。
 */
export async function loadUploadFile(filePath) {
  // 从仓库根目录运行 demo 时，这里把相对路径展开成绝对路径，避免 cwd 差异导致读不到文件。
  const absolutePath = resolve(process.cwd(), filePath);
  const content = await readFile(absolutePath);
  return new File([content], basename(absolutePath), { type: "text/plain" });
}

/**
 * 为一次异步操作增加超时保护，避免 ACP demo 无感挂起。
 */
export async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
