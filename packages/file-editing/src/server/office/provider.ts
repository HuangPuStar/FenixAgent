import { hkdfSync } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { EditingError, type OfficeSession } from "../../../contracts";
import quotePlugin from "../../../office-plugin/config.json";
import type { EditingPolicy, EditingSessionRecord } from "../session-state";

/** Configured provider and trusted callback base; never derived from request headers. */
export interface EditingServiceConfig {
  publicUrl: string;
  jwtSecret: string;
  baseUrl: string;
}
/** A fetch-compatible HTTP port, injectable without loading workspace or host modules. */
export type EditingFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
/** Signed provider fields; unsigned body fields never participate in authorization. */
export interface OfficeCallback {
  key: string;
  status: number;
  url?: string;
  filetype?: string;
  userdata?: string;
}

/** Formats eligible for Office editing; the host can restrict its enabled capability subset. */
export const OFFICE_EDITABLE_EXTENSIONS = Object.freeze(["docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf"] as const);

function httpUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("Invalid URL");
    return url;
  } catch {
    throw new EditingError(
      "invalid-input",
      "Document service configuration must use HTTP(S) URLs without credentials, query or fragment",
    );
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Provider protocol and cryptography, independent from file access and session persistence. */
export class OfficeProvider {
  private readonly url: URL;
  private readonly base: string;
  private readonly jwtKey: Uint8Array;
  private readonly keys: Record<"document" | "callback", Uint8Array>;
  private downloads = 0;
  private readonly controllers = new Set<AbortController>();
  constructor(
    config: EditingServiceConfig,
    private readonly fetch: EditingFetch,
    private readonly policy: EditingPolicy,
    private readonly now: () => number,
  ) {
    this.url = httpUrl(config.publicUrl);
    this.base = httpUrl(config.baseUrl).href.replace(/\/$/, "");
    if (!config.jwtSecret) throw new EditingError("invalid-input", "Document JWT secret is required");
    this.jwtKey = new TextEncoder().encode(config.jwtSecret);
    this.keys = {
      document: new Uint8Array(hkdfSync("sha256", this.jwtKey, "fenix-file-editing-v1", "office-document", 32)),
      callback: new Uint8Array(hkdfSync("sha256", this.jwtKey, "fenix-file-editing-v1", "office-callback", 32)),
    };
  }
  /** Sign a strict single-editor configuration with separate-purpose back-channel references. */
  async initialization(record: EditingSessionRecord, lang?: string): Promise<OfficeSession["initialization"]> {
    const documentToken = await this.signReference(record, "document");
    const callbackToken = await this.signReference(record, "callback");
    const documentType = ["xlsx", "ods"].includes(record.fileType)
      ? "cell"
      : ["pptx", "odp"].includes(record.fileType)
        ? "slide"
        : "word";
    const config: Record<string, unknown> = {
      document: {
        fileType: record.fileType,
        key: record.documentKey,
        title: record.path.split("/").pop(),
        url: `${this.base}/office/documents/${documentToken}`,
        permissions: { edit: true, download: true, print: false, comment: false },
      },
      documentType,
      editorConfig: {
        lang: lang?.startsWith("en") ? "en-US" : "zh-CN",
        mode: "edit",
        plugins: {
          autostart: [quotePlugin.guid],
          pluginsData: [
            `${this.url.href.replace(/\/$/, "")}/sdkjs-plugins/${quotePlugin.guid.slice(4)}/config.json?v=${encodeURIComponent(quotePlugin.version)}`,
          ],
        },
        callbackUrl: `${this.base}/office/callbacks/${callbackToken}`,
        user: { id: record.scope.userId, name: record.scope.userId },
        coEditing: { mode: "strict", change: false },
        // Provider cache synchronization must finish before the app requests a workspace forcesave.
        customization: { autosave: true, forcesave: false, features: { spellcheck: false } },
      },
    };
    config.token = await this.jwt(config);
    return { scriptUrl: `${this.url.href.replace(/\/$/, "")}/web-apps/apps/api/documents/api.js`, config };
  }
  private async jwt(payload: Record<string, unknown>): Promise<string> {
    return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).sign(this.jwtKey);
  }
  private async signReference(record: EditingSessionRecord, purpose: "document" | "callback"): Promise<string> {
    return new SignJWT({ id: record.id, key: record.documentKey, scope: record.scope, path: record.path })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience(`office-${purpose}-v1`)
      .setIssuedAt(Math.floor(this.now() / 1000))
      .setExpirationTime(Math.ceil(record.hardExpiresAt / 1000))
      .sign(this.keys[purpose]);
  }
  /** Verify a purpose-bound token without granting access to a missing server-side session. */
  async reference(
    token: string,
    purpose: "document" | "callback",
  ): Promise<{ id: string; matches(record: EditingSessionRecord): boolean }> {
    try {
      const { payload } = await jwtVerify(token, this.keys[purpose], {
        algorithms: ["HS256"],
        audience: `office-${purpose}-v1`,
        currentDate: new Date(this.now()),
      });
      if (typeof payload.id !== "string" || !object(payload.scope)) throw new Error("Invalid reference");
      const scope = payload.scope;
      return {
        id: payload.id,
        matches: (record) =>
          payload.key === record.documentKey &&
          payload.path === record.path &&
          scope.organizationId === record.scope.organizationId &&
          scope.userId === record.scope.userId &&
          scope.environmentId === record.scope.environmentId,
      };
    } catch {
      throw new EditingError("forbidden", "Invalid or expired Office reference");
    }
  }
  /** Read only authenticated JWT claims from the provider's otherwise untrusted request body. */
  async callback(body: unknown): Promise<OfficeCallback> {
    if (!object(body) || typeof body.token !== "string")
      throw new EditingError("forbidden", "Signed callback is required");
    try {
      const { payload } = await jwtVerify(body.token, this.jwtKey, {
        algorithms: ["HS256"],
        currentDate: new Date(this.now()),
      });
      const fields = object(payload.payload) ? payload.payload : payload;
      if (typeof fields.key !== "string" || typeof fields.status !== "number") throw new Error("Invalid fields");
      return {
        key: fields.key,
        status: fields.status,
        ...(typeof fields.url === "string" ? { url: fields.url } : {}),
        ...(typeof fields.filetype === "string" ? { filetype: fields.filetype } : {}),
        ...(typeof fields.userdata === "string" ? { userdata: fields.userdata } : {}),
      };
    } catch {
      throw new EditingError("forbidden", "Invalid Office callback signature or payload");
    }
  }
  /** Request provider cache materialization; the reply does not prove a workspace file was saved. */
  async forceSave(record: EditingSessionRecord, saveId: string): Promise<number> {
    const command = { c: "forcesave", key: record.documentKey, userdata: saveId };
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.policy.timeoutMs);
    try {
      const response = await this.fetch(`${this.url.href.replace(/\/$/, "")}/coauthoring/CommandService.ashx`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...command, token: await this.jwt(command) }),
      });
      if (!response.ok || response.redirected) {
        await response.body?.cancel();
        throw new EditingError("unavailable", "Document save command failed");
      }
      // Command replies are tiny; a hostile provider must not allocate unbounded JSON here either.
      const bytes = await this.readBounded(response, 64 * 1024, controller.signal);
      const reply: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!object(reply) || typeof reply.error !== "number")
        throw new EditingError("unavailable", "Invalid document save reply");
      return reply.error;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  /** Download only bounded provider-origin bytes, with no redirect or credential forwarding. */
  async download(value: string): Promise<Uint8Array> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new EditingError("invalid-input", "Invalid document result URL");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin !== this.url.origin)
      throw new EditingError("forbidden", "Document result origin is not allowed");
    if (this.downloads >= this.policy.maxDownloads)
      throw new EditingError("busy", "Document download capacity reached");
    this.downloads += 1;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.policy.timeoutMs);
    try {
      const response = await this.fetch(url, { redirect: "error", signal: controller.signal });
      if (!response.ok || response.redirected) {
        await response.body?.cancel();
        throw new EditingError("unavailable", "Document result download failed");
      }
      return await this.readBounded(response, this.policy.maxFileBytes, controller.signal);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      this.downloads -= 1;
    }
  }
  /** Cancel provider requests owned by this service without affecting the injected fetch client. */
  dispose(): void {
    for (const controller of this.controllers) controller.abort();
  }
  private async readBounded(response: Response, max: number, signal?: AbortSignal): Promise<Uint8Array> {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) {
      await response.body?.cancel();
      throw new EditingError("too-large", "Document result exceeds byte limit");
    }
    if (!response.body) throw new EditingError("unavailable", "Document result has no body");
    const reader = response.body.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        total += value.byteLength;
        if (total > max) throw new EditingError("too-large", "Document result exceeds byte limit");
        chunks.push(value);
      }
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    } catch (error) {
      await reader.cancel();
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
}
