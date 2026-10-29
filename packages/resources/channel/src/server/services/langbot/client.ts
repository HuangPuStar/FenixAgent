import { ChannelControlError } from "../../contracts";
import type {
  CreateLangBotBotInput,
  LangBotBot,
  LangBotSendMessageInput,
  LangBotStatus,
  UpdateLangBotBotInput,
} from "./types";

/**
 * LangBot Service API 客户端。
 *
 * 边界职责只有三件：鉴权头、超时与响应限长、把上游响应归一为 {@link ChannelControlError}。业务编排
 * （先远端后本地、补偿、状态维护）在 `channel-service.ts`。
 *
 * 安全约束：
 * 1. 错误文案只含固定短语与 HTTP 状态码，绝不携带上游 `msg`、响应体或 `X-API-Key`——上游 `msg` 可能回显
 *    请求内容，而请求体里就是适配器凭据。
 * 2. 所有路径由内部常量拼成，`botUuid` 只经单段编码；请求不允许重定向（`redirect: "error"`），避免密钥
 *    被带到另一个 origin。
 * 3. 响应体按字节数限长：LangBot 出错时可能返回整页 HTML，原样读入会成为内存放大面。
 *
 * 本客户端不缓存 Bot 列表、不做自动重试：创建 Bot 的超时结果未知，重试 POST 会制造重复 Bot，重试策略
 * 必须留给明确知道幂等性的调用方。客户端只回答「这次失败是否值得再试」——`retryable` 由上游状态决定，
 * 调用方据此决定重试，而不是自己按 HTTP 状态猜。
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface LangBotClientOptions {
  /** 基址，例如 `http://langbot:5300/api/v1`；必须含协议与主机。 */
  readonly baseUrl: string;
  /** Service API 的实例级共享密钥；只用于请求头，不进入任何错误或日志。 */
  readonly apiKey: string;
  readonly timeoutMs?: number;
  /** 测试注入点；生产使用全局 `fetch`。 */
  readonly fetcher?: typeof fetch;
}

export interface LangBotClient {
  /** 探测可达性；不可达时返回 `reachable: false`，不抛错（状态端点本身就是用来展示这一事实的）。 */
  status(): Promise<LangBotStatus>;
  listBots(): Promise<readonly LangBotBot[]>;
  getBot(botUuid: string): Promise<LangBotBot>;
  /** 创建成功后返回上游分配的 UUID；不在这里回读详情，避免把「已创建」误报为失败。 */
  createBot(input: CreateLangBotBotInput): Promise<string>;
  updateBot(botUuid: string, input: UpdateLangBotBotInput): Promise<void>;
  /** 删除幂等：上游 404 视为「已经不存在」。 */
  deleteBot(botUuid: string): Promise<void>;
  sendMessage(botUuid: string, input: LangBotSendMessageInput): Promise<void>;
}

/** 校验基址；非法配置按「未正确配置」处理，而不是在请求期拼出一个奇怪 URL。 */
function parseBaseUrl(raw: string): URL {
  let base: URL;
  try {
    base = new URL(raw);
  } catch (cause) {
    throw new ChannelControlError("LANGBOT_NOT_CONFIGURED", 503, "LANGBOT_BASE_URL 不是合法 URL", { cause });
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new ChannelControlError("LANGBOT_NOT_CONFIGURED", 503, "LANGBOT_BASE_URL 仅支持 http/https");
  }
  return base;
}

/** 单段路径编码：拒绝 `..` 与斜杠，防止资源标识把请求带出基址路径。 */
function encodeSegment(value: string): string {
  const encoded = encodeURIComponent(value);
  if (encoded === "." || encoded === ".." || encoded.includes("/")) {
    throw new ChannelControlError("INVALID_INPUT", 400, "LangBot 资源标识不合法");
  }
  return encoded;
}

/** 在基址下拼接内部路径；结果必须仍在基址的 origin 与路径前缀内。 */
function endpoint(base: URL, relativePath: string): URL {
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const url = new URL(relativePath, `${base.origin}${basePath}`);
  if (url.origin !== base.origin || !url.pathname.startsWith(basePath)) {
    throw new ChannelControlError("LANGBOT_NOT_CONFIGURED", 503, "LANGBOT_BASE_URL 不能跨 origin 或跳出路径前缀");
  }
  return url;
}

function badResponse(cause?: unknown): ChannelControlError {
  return new ChannelControlError("LANGBOT_BAD_RESPONSE", 502, "LangBot 返回了无法识别的响应", { cause });
}

/** 读取响应体并限制字节数；超过上限按坏响应处理，不继续读入内存。 */
async function readBodyLimited(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) throw badResponse();
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw badResponse();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw badResponse(cause);
  }
}

/** 上游错误只保留状态码与错误码，不把 `msg` 带进平台错误。 */
function rejected(status: number, upstreamCode?: number): ChannelControlError {
  const detail = upstreamCode === undefined ? `HTTP ${status}` : `HTTP ${status} / code ${upstreamCode}`;
  // 5xx 与 429 是上游瞬时状态，值得再试一次；其余 4xx 与 HTTP 200 的业务拒绝都是确定性失败。
  return new ChannelControlError("LANGBOT_REJECTED", 502, `LangBot 拒绝了请求（${detail}）`, {
    retryable: status >= 500 || status === 429,
  });
}

/** 把 LangBot 的响应信封拆成 `data`；`code !== 0` 是业务失败。 */
function unwrapEnvelope(text: string): unknown {
  const envelope = parseJson(text);
  if (typeof envelope !== "object" || envelope === null) throw badResponse();
  const record = envelope as Record<string, unknown>;
  if (record.code !== undefined && record.code !== 0) {
    if (typeof record.code !== "number") throw badResponse();
    throw rejected(200, record.code);
  }
  return record.data;
}

function toBot(value: unknown): LangBotBot {
  if (typeof value !== "object" || value === null) throw badResponse();
  const record = value as Record<string, unknown>;
  if (typeof record.uuid !== "string" || typeof record.name !== "string" || typeof record.adapter !== "string") {
    throw badResponse();
  }
  return {
    uuid: record.uuid,
    name: record.name,
    adapter: record.adapter,
    createdAt: typeof record.created_at === "string" ? record.created_at : null,
    updatedAt: typeof record.updated_at === "string" ? record.updated_at : null,
  };
}

export function createLangBotClient(options: LangBotClientOptions): LangBotClient {
  const base = parseBaseUrl(options.baseUrl);
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(input: {
    readonly method: "GET" | "POST" | "PUT" | "DELETE";
    readonly path: string;
    readonly body?: unknown;
    readonly botNotFound?: boolean;
    readonly timeoutMs?: number;
  }): Promise<unknown> {
    const url = endpoint(base, input.path);
    let response: Response;
    try {
      response = await fetcher(url, {
        method: input.method,
        // 密钥只允许发往配置的 origin；重定向会让 fetch 把它带去别处。
        redirect: "error",
        signal: AbortSignal.timeout(input.timeoutMs ?? timeoutMs),
        headers: {
          "X-API-Key": options.apiKey,
          Accept: "application/json",
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      });
    } catch (cause) {
      throw new ChannelControlError("LANGBOT_UNREACHABLE", 503, "LangBot 不可达或请求超时", {
        cause,
        retryable: true,
      });
    }

    const text = await readBodyLimited(response);
    if (response.status === 401 || response.status === 403) {
      throw new ChannelControlError("LANGBOT_UNAUTHORIZED", 502, "LangBot 拒绝了服务端 API Key");
    }
    if (response.status === 404) {
      if (input.botNotFound === true) {
        throw new ChannelControlError("LANGBOT_BOT_NOT_FOUND", 404, "LangBot 中不存在该 Bot");
      }
      throw rejected(response.status);
    }
    if (!response.ok) throw rejected(response.status);
    if (text.trim() === "") return null;
    return unwrapEnvelope(text);
  }

  /** 探测用请求：不抛错、不带密钥，只回答「这个 URL 是否返回 2xx」。 */
  async function probe(url: URL): Promise<boolean> {
    try {
      const response = await fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function systemInfo(): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetcher(endpoint(base, "system/info"), {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      const text = await readBodyLimited(response);
      const data = unwrapEnvelope(text);
      return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
    } catch {
      // 系统信息是展示增强：探测已经成功时，取不到版本不等于服务不可达。
      return null;
    }
  }

  /**
   * 读取远端 Bot 的现有适配器配置，供部分更新时合并。
   *
   * LangBot 的 PUT 是整体替换 `adapter_config`，而编辑表单只回填用户填写的字段；
   * 先读回再合并，避免留空的密钥被覆盖。没有 RESOURCE_MANAGE 时上游会返回掩码字符串，
   * 这种情况必须报错而不是拿掩码去覆盖真实密钥。
   */
  async function readAdapterConfig(botUuid: string): Promise<Record<string, unknown>> {
    const data = await call({
      method: "GET",
      path: `platform/bots/${encodeSegment(botUuid)}`,
      botNotFound: true,
    });
    if (typeof data !== "object" || data === null) throw badResponse();
    const bot = (data as { bot?: unknown }).bot;
    if (typeof bot !== "object" || bot === null) throw badResponse();
    const config = (bot as { adapter_config?: unknown }).adapter_config;
    if (config === undefined || config === null) return {};
    if (typeof config !== "object" || Array.isArray(config)) {
      throw new ChannelControlError("LANGBOT_REJECTED", 502, "LangBot 未返回可合并的适配器配置");
    }
    return { ...(config as Record<string, unknown>) };
  }

  return {
    async status() {
      const healthy = await probe(new URL("/healthz", base));
      if (!healthy) return { reachable: false, version: null, edition: null, wizardStatus: null };
      const info = await systemInfo();
      return {
        reachable: true,
        version: typeof info?.version === "string" ? info.version : null,
        edition: typeof info?.edition === "string" ? info.edition : null,
        wizardStatus: typeof info?.wizard_status === "string" ? info.wizard_status : null,
      };
    },

    async listBots() {
      const data = await call({ method: "GET", path: "platform/bots" });
      if (typeof data !== "object" || data === null) throw badResponse();
      const bots = (data as { bots?: unknown }).bots;
      if (!Array.isArray(bots)) throw badResponse();
      return bots.map(toBot);
    },

    async getBot(botUuid) {
      const data = await call({
        method: "GET",
        path: `platform/bots/${encodeSegment(botUuid)}`,
        botNotFound: true,
      });
      if (typeof data !== "object" || data === null) throw badResponse();
      return toBot((data as { bot?: unknown }).bot);
    },

    async createBot(input) {
      const data = await call({
        method: "POST",
        path: "platform/bots",
        // 上游字段名是 adapter_config；发送 config 会被 BOT_FIELDS 白名单丢掉，触发 NOT NULL 500。
        // 新建的 Bot 默认 enable=false，适配器不会启动、通道永远收不到消息，所以创建时就显式启用。
        body: { name: input.name, adapter: input.adapter, adapter_config: input.config, enable: true },
      });
      const uuid = typeof data === "object" && data !== null ? (data as { uuid?: unknown }).uuid : undefined;
      if (typeof uuid !== "string" || uuid.length === 0) throw badResponse();

      try {
        // 上游 create 只 load 不 run；再 PUT 一次才会 remove→load→run，适配器这时才真正连接 IM。
        await call({ method: "PUT", path: `platform/bots/${encodeSegment(uuid)}`, body: { enable: true } });
      } catch (error) {
        // 启动失败时远端已经留下这行 Bot，补偿删除，避免重试时出现同名孤儿。
        await call({ method: "DELETE", path: `platform/bots/${encodeSegment(uuid)}` }).catch(() => undefined);
        throw error;
      }
      return uuid;
    },

    async updateBot(botUuid, input) {
      // 上游是 PUT：只发送显式提供的字段，未提供 config 时绝不能补一个空对象覆盖原配置。
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.adapter !== undefined) body.adapter = input.adapter;
      if (input.config !== undefined) {
        body.adapter_config = { ...(await readAdapterConfig(botUuid)), ...input.config };
      }
      await call({ method: "PUT", path: `platform/bots/${encodeSegment(botUuid)}`, body, botNotFound: true });
    },

    async deleteBot(botUuid) {
      try {
        await call({ method: "DELETE", path: `platform/bots/${encodeSegment(botUuid)}`, botNotFound: true });
      } catch (error) {
        // 幂等删除：上一次调用可能已经删掉远端，只有这种 404 可以继续走本地清理。
        if (error instanceof ChannelControlError && error.code === "LANGBOT_BOT_NOT_FOUND") return;
        throw error;
      }
    },

    async sendMessage(botUuid, input) {
      const data = await call({
        method: "POST",
        path: `platform/bots/${encodeSegment(botUuid)}/send_message`,
        body: {
          target_type: input.targetType,
          target_id: input.targetId,
          message_chain: [
            // At 必须在 Plain 之前：LangBot 的发送目标按消息链顺序渲染，顺序错误会变成「正文 @ 某人」。
            ...(input.mentionUserId ? [{ type: "At", target: input.mentionUserId }] : []),
            { type: "Plain", text: input.text },
          ],
        },
      });
      const sent = typeof data === "object" && data !== null ? (data as { sent?: unknown }).sent : undefined;
      if (sent !== true) throw new ChannelControlError("SEND_FAILED", 502, "LangBot 未确认消息已发送");
    },
  };
}
