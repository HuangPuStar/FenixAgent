import { type ApiResult, err, ok } from "./result";

type Params = Record<string, string | number>;
type QueryParams = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  params?: Params;
  query?: QueryParams;
}

export class BaseApi {
  /**
   * 从异常响应体中提取统一错误对象。
   * 兼容控制台标准 { success: false, error }、Elysia error()，以及原生 ValidationError 响应。
   */
  private extractError<T>(response: Response, json: unknown): ApiResult<T> | null {
    if (json && typeof json === "object" && "success" in json) {
      if (json.success === false && "error" in json) {
        const errorObj = (json as { error: { code?: string; message?: string; type?: string } }).error;
        return err(
          errorObj.code ?? errorObj.type ?? "UNKNOWN_ERROR",
          errorObj.message ?? "Unknown error",
          response.status,
          "data" in json ? (json as { data?: unknown }).data : undefined,
        );
      }
      return null;
    }

    if (json && typeof json === "object" && "error" in json && !("success" in json)) {
      const errorObj = (json as { error: { type?: string; message?: string; code?: string } }).error;
      if (typeof errorObj === "object" && errorObj !== null) {
        return err(
          errorObj.code ?? errorObj.type ?? "UNKNOWN_ERROR",
          errorObj.message ?? "Unknown error",
          response.status,
        );
      }
    }

    if (!response.ok && json && typeof json === "object") {
      const validationBody = json as {
        type?: string;
        code?: string;
        summary?: string;
        message?: string;
        property?: string;
        path?: string;
      };
      const rawCode = validationBody.code ?? validationBody.type;
      const errorCode = rawCode === "validation" ? "VALIDATION_ERROR" : (rawCode ?? "HTTP_ERROR");
      const rawMessage = validationBody.summary ?? validationBody.message ?? response.statusText;
      const errorPath = validationBody.property ?? validationBody.path;
      const message = errorPath && rawMessage ? `${errorPath}: ${rawMessage}` : rawMessage || `HTTP ${response.status}`;
      return err(errorCode, message, response.status);
    }

    return null;
  }

  protected replaceParams(path: string, params?: Params): string {
    if (!params) return path;
    let result = path;
    for (const [key, value] of Object.entries(params)) {
      result = result.replace(`:${key}`, String(value));
    }
    return result;
  }

  protected buildQuery(query?: QueryParams): string {
    if (!query) return "";
    const entries = Object.entries(query).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "";
    const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    return `?${qs}`;
  }

  protected async handleResponse<T>(response: Response): Promise<ApiResult<T>> {
    if (!response.ok && response.status >= 500) {
      const text = await response.text().catch(() => response.statusText);
      return err("SERVER_ERROR", text || response.statusText, response.status);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return err("INVALID_RESPONSE", `无法解析响应: ${response.status}`, response.status);
    }

    // 标准格式 { success: true, data: T }
    if (json && typeof json === "object" && "success" in json) {
      if (json.success === true && "data" in json) {
        return ok((json as { data: T }).data);
      }
    }

    const extractedError = this.extractError<T>(response, json);
    if (extractedError) {
      return extractedError;
    }

    // 非标准格式直接返回
    return ok(json as T);
  }

  protected async _get<T>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, { method: "GET", credentials: "include" });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }

  protected async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }

  protected async put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }

  protected async patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }

  protected async del<T>(path: string, options?: RequestOptions & { body?: unknown }): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, {
        method: "DELETE",
        headers: options?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        credentials: "include",
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }

  protected async _upload<T>(path: string, formData: FormData, options?: RequestOptions): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }
}
