import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  AgentDetail,
  AgentInfo,
  McpInspectResult,
  McpServerDetail,
  McpServerInfo,
  McpToolInfo,
  ModelConfig,
  ModelEntry,
  ProviderDetail,
  ProviderInfo,
  SkillDetail,
  SkillInfo,
} from "../types/schemas";

export class ProviderApi extends BaseApi {
  async list(): Promise<ApiResult<ProviderInfo[]>> {
    return this._get<ProviderInfo[]>("/web/config/providers");
  }
  async get(name: string): Promise<ApiResult<ProviderDetail>> {
    return this._get<ProviderDetail>("/web/config/providers/:name", { params: { name } });
  }
  async create(name: string, data: Record<string, unknown>): Promise<ApiResult<ProviderInfo>> {
    return this.post<ProviderInfo>("/web/config/providers", { name, ...data });
  }
  async set(name: string, data: Record<string, unknown>): Promise<ApiResult<ProviderInfo>> {
    return this.put<ProviderInfo>("/web/config/providers/:name", data, { params: { name } });
  }
  async test(
    name: string,
    inline?: { apiKey?: string; baseURL?: string; protocol?: string },
  ): Promise<ApiResult<{ success: boolean; error?: string }>> {
    return this.post("/web/config/providers/:name/test", inline ?? {}, { params: { name } });
  }
  async testModel(name: string, modelId: string): Promise<ApiResult<{ ok: boolean; content: string }>> {
    return this.post("/web/config/providers/:name/models/:modelId/test", {}, { params: { name, modelId } });
  }
  async delete(name: string): Promise<ApiResult<boolean>> {
    return this.del<boolean>("/web/config/providers/:name", { params: { name } });
  }
  async addModel(name: string, modelData: Record<string, unknown>): Promise<ApiResult<ModelEntry>> {
    return this.post<ModelEntry>("/web/config/providers/:name/models", modelData, { params: { name } });
  }
  async updateModel(name: string, modelId: string, modelData: Record<string, unknown>): Promise<ApiResult<ModelEntry>> {
    return this.put<ModelEntry>("/web/config/providers/:name/models/:modelId", modelData, {
      params: { name, modelId },
    });
  }
  async removeModel(name: string, modelId: string): Promise<ApiResult<boolean>> {
    return this.del<boolean>("/web/config/providers/:name/models/:modelId", { params: { name, modelId } });
  }
}

export class ModelApi extends BaseApi {
  async get(): Promise<ApiResult<ModelConfig>> {
    return this._get<ModelConfig>("/web/config/models");
  }
  async set(data: Record<string, unknown>): Promise<ApiResult<ModelConfig>> {
    return this.put<ModelConfig>("/web/config/models", data);
  }
  async refresh(): Promise<ApiResult<{ count: number }>> {
    return this.post<{ count: number }>("/web/config/models/refresh");
  }
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  skills: string[];
}

export class AgentApi extends BaseApi {
  async templates(): Promise<ApiResult<{ templates: AgentTemplate[] }>> {
    return this._get<{ templates: AgentTemplate[] }>("/web/config/agents/templates");
  }
  async list(): Promise<ApiResult<{ default_agent: string | null; agents: AgentInfo[] }>> {
    return this._get<{ default_agent: string | null; agents: AgentInfo[] }>("/web/config/agents");
  }
  async get(name: string): Promise<ApiResult<AgentDetail>> {
    return this._get<AgentDetail>("/web/config/agents", { query: { name } });
  }
  async set(name: string, data: Record<string, unknown>): Promise<ApiResult<AgentDetail>> {
    return this.put<AgentDetail>("/web/config/agents", { data }, { query: { name } });
  }
  async create(name: string, data: Record<string, unknown>): Promise<ApiResult<AgentDetail>> {
    return this.post<AgentDetail>("/web/config/agents", { name, data });
  }
  async delete(name: string): Promise<ApiResult<boolean>> {
    return this.del("/web/config/agents", { query: { name } });
  }
  async setDefault(
    name: string,
  ): Promise<ApiResult<{ default_agent: string; resourceAccess?: AgentDetail["resourceAccess"] }>> {
    return this.post<{ default_agent: string; resourceAccess?: AgentDetail["resourceAccess"] }>(
      "/web/config/agents/default",
      { name },
    );
  }
}

export class SkillConfigApi extends BaseApi {
  async list(): Promise<ApiResult<SkillInfo[]>> {
    return this.post<SkillInfo[]>("/web/config/skills", { action: "list" });
  }
  async get(name: string): Promise<ApiResult<SkillDetail>> {
    return this.post<SkillDetail>("/web/config/skills", { action: "get", name });
  }
  async set(name: string, data: Record<string, unknown>): Promise<ApiResult<SkillInfo>> {
    return this.post<SkillInfo>("/web/config/skills", { action: "set", name, data });
  }
  async delete(name: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/skills", { action: "delete", name });
  }
  async upload(formData: FormData): Promise<ApiResult<SkillInfo>> {
    return this._upload<SkillInfo>("/web/config/skills/upload", formData);
  }
}

export class McpApi extends BaseApi {
  async list(): Promise<ApiResult<McpServerInfo[]>> {
    return this._get<McpServerInfo[]>("/web/config/mcp");
  }
  async get(name: string): Promise<ApiResult<McpServerDetail>> {
    return this._get<McpServerDetail>("/web/config/mcp/:name", { params: { name } });
  }
  async create(name: string, data: Record<string, unknown>): Promise<ApiResult<McpServerInfo>> {
    return this.post<McpServerInfo>("/web/config/mcp", { name, ...data });
  }
  async set(name: string, data: Record<string, unknown>): Promise<ApiResult<McpServerInfo>> {
    return this.put<McpServerInfo>("/web/config/mcp/:name", data, { params: { name } });
  }
  async delete(name: string): Promise<ApiResult<boolean>> {
    return this.del<boolean>("/web/config/mcp/:name", { params: { name } });
  }
  async enable(name: string): Promise<ApiResult<McpServerInfo>> {
    return this.post<McpServerInfo>("/web/config/mcp/:name/enable", {}, { params: { name } });
  }
  async disable(name: string): Promise<ApiResult<McpServerInfo>> {
    return this.post<McpServerInfo>("/web/config/mcp/:name/disable", {}, { params: { name } });
  }
  async test(name: string): Promise<ApiResult<{ success: boolean; error?: string }>> {
    return this.post("/web/config/mcp/:name/test", {}, { params: { name } });
  }
  async testUrl(url: string): Promise<ApiResult<{ success: boolean; error?: string }>> {
    return this.post("/web/config/mcp/test-url", { url });
  }
  async inspect(name: string): Promise<ApiResult<McpInspectResult>> {
    return this.post<McpInspectResult>("/web/config/mcp/:name/inspect", {}, { params: { name } });
  }
  async listTools(name: string): Promise<ApiResult<McpToolInfo[]>> {
    return this._get<McpToolInfo[]>("/web/config/mcp/:name/tools", { params: { name } });
  }
}
