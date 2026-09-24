import { PluginMarketError } from "../errors";
import { digestSnapshot, normalizePackageVersion, serializeSnapshot } from "./normalize";
import type { NormalizedPackageVersion, PackageVersionRef, PublicationPreview } from "./types";

/** 可注入的 fetch；测试用本地 fixture registry 替换，生产走全局 `fetch`。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PluginRegistryClientOptions {
  /** 固定的私有源 origin。调用方**永远不能**提供 URL，请求路径只能由校验过的包名派生。 */
  readonly baseUrl: string;
  /** Bearer 凭据；未配置为 null。属凭据材料：不进日志、不进响应、不进错误详情。 */
  readonly token: string | null;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly fetchImpl?: FetchLike;
}

/** 只跟同源重定向，且最多 2 跳：凭据与「固定 origin」这条约束都不能被上游改写的 Location 绕过。 */
const MAX_REDIRECTS = 2;

const concatChunks = (chunks: Uint8Array[], total: number): Uint8Array => {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
};

/**
 * 流式有界读取。
 *
 * 不用 `response.text()` 再判长度：那时已经把整个响应体读进内存，敌意源可以先用一个超大响应把进程打爆，
 * 长度判定根本来不及执行。这里边读边累计，越界即取消并断开。
 */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PluginMarketError("METADATA_TOO_LARGE", "私有源响应超过大小上限");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatChunks(chunks, total));
}

const statusToError = (status: number): PluginMarketError => {
  if (status === 404) return new PluginMarketError("PACKAGE_NOT_FOUND", "私有源中不存在该包");
  if (status === 429) return new PluginMarketError("REGISTRY_RATE_LIMITED", "私有源限流，请稍后重试");
  return new PluginMarketError("REGISTRY_UNAVAILABLE", `私有源返回 ${status}`);
};

/**
 * 单个已配置 npm 私有源之上的**只读防腐层**。
 *
 * 它不持有任何业务状态，也不提供通用 URL 抓取：请求路径永远由校验过的包名派生，origin 由构造参数固定。
 * 「调用方不能提供 URL」是这一层最重要的性质——否则市场会变成一台可被诱导去读内网地址的代理。
 *
 * 本类**不读模块配置**：配置来自 `service.ts` 的 `getPluginRegistryClient()`，构造参数显式传入，使测试可以
 * 直接对着 loopback fixture registry 构造实例。
 */
export class PluginRegistryClient {
  readonly #baseUrl: string;
  readonly #token: string | null;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #fetch: FetchLike;

  constructor(options: PluginRegistryClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs;
    this.#maxBytes = options.maxBytes;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * 读取一个精确版本并产出规范化快照 + 摘要。
   *
   * 只读 packument（包元数据）：**永不请求 tarball**，也不解压任何内容。市场展示的是声明，不是代码。
   */
  async preview(ref: PackageVersionRef): Promise<PublicationPreview> {
    const url = `${this.#baseUrl}/${encodeURIComponent(ref.packageName)}`;
    const packument = await this.#fetchPackument(url);
    const metadata = normalizePackageVersion(packument, ref);
    const snapshot: NormalizedPackageVersion = { ...metadata, publishedAt: this.#readPublishedAt(packument, ref) };
    const metadataJson = serializeSnapshot(snapshot);
    return {
      ref,
      metadata: snapshot,
      metadataJson,
      metadataDigest: await digestSnapshot(metadataJson),
    };
  }

  /** 取 `time[exactVersion]`；缺失或非法时返回 null，不臆造日期。 */
  #readPublishedAt(packument: unknown, ref: PackageVersionRef): string | null {
    if (typeof packument !== "object" || packument === null) return null;
    const time = (packument as Record<string, unknown>).time;
    if (typeof time !== "object" || time === null) return null;
    const value = (time as Record<string, unknown>)[ref.exactVersion];
    if (typeof value !== "string") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  async #fetchPackument(url: string): Promise<unknown> {
    const origin = new URL(this.#baseUrl).origin;
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.#request(current);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new PluginMarketError("REGISTRY_UNAVAILABLE", "私有源返回重定向但缺少 Location");
        // 只跟同源重定向：固定 origin 因此不可能被改写到攻击者控制的地址，凭据也不会外泄到别的 host。
        let target: URL;
        try {
          target = new URL(location, current);
        } catch {
          throw new PluginMarketError("REGISTRY_UNAVAILABLE", "私有源返回的重定向目标非法");
        }
        if (target.origin !== origin) throw new PluginMarketError("REGISTRY_UNAVAILABLE", "拒绝跨源重定向");
        current = target.toString();
        continue;
      }
      if (!response.ok) throw statusToError(response.status);
      const text = await readBounded(response, this.#maxBytes);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new PluginMarketError("METADATA_INVALID", "私有源响应不是 JSON");
      }
    }
    throw new PluginMarketError("REGISTRY_UNAVAILABLE", "重定向层数超过上限");
  }

  async #request(url: string): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    try {
      return await this.#fetch(url, {
        method: "GET",
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof PluginMarketError) throw error;
      throw new PluginMarketError("REGISTRY_UNAVAILABLE", "私有源请求失败", {
        // 只暴露错误的类名（如 TimeoutError）：上游文本可能回显请求细节，绝不向外传递。
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
