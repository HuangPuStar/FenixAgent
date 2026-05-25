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
  SkillInfo,
} from "../types/schemas";

export class ProviderApi extends BaseApi {
  async list(): Promise<ApiResult<ProviderInfo[]>> {
    return this.post<ProviderInfo[]>("/web/config/providers", { action: "list" });
  }
  async get(name: string): Promise<ApiResult<ProviderDetail>> {
    return this.post<ProviderDetail>("/web/config/providers", { action: "get", name });
  }
  async set(name: string, data: Record<string, unknown>): Promise<ApiResult<ProviderInfo>> {
    return this.post<ProviderInfo>("/web/config/providers", { action: "set", name, data });
  }
  async test(name: string): Promise<ApiResult<{ success: boolean; error?: string }>> {
    return this.post("/web/config/providers", { action: "test", name });
  }
  async delete(name: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/providers", { action: "delete", name });
  }
  async addModel(name: string, modelData: Record<string, unknown>): Promise<ApiResult<ModelEntry>> {
    return this.post("/web/config/providers", { action: "add_model", name, data: modelData });
  }
  async updateModel(name: string, modelData: Record<string, unknown>): Promise<ApiResult<ModelEntry>> {
    return this.post("/web/config/providers", { action: "update_model", name, data: modelData });
  }
  async removeModel(name: string, modelId: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/providers", { action: "remove_model", name, modelId });
  }
}

export class ModelApi extends BaseApi {
  async get(): Promise<ApiResult<ModelConfig>> {
    return this.post<ModelConfig>("/web/config/models", { action: "get" });
  }
  async set(data: Record<string, unknown>): Promise<ApiResult<ModelConfig>> {
    return this.post<ModelConfig>("/web/config/models", { action: "set", data });
  }
  async refresh(): Promise<ApiResult<ModelEntry[]>> {
    return this.post<ModelEntry[]>("/web/config/models", { action: "refresh" });
  }
}

export class AgentApi extends BaseApi {
  async list(): Promise<ApiResult<AgentInfo[]>> {
    return this.post<AgentInfo[]>("/web/config/agents", { action: "list" });
  }
  async get(name: string): Promise<ApiResult<AgentDetail>> {
    return this.post<AgentDetail>("/web/config/agents", { action: "get", name });
  }
  async set(name: string, data: Record<string, unknown>): Promise<ApiResult<AgentDetail>> {
    return this.post<AgentDetail>("/web/config/agents", { action: "set", name, data });
  }
  async create(name: string, data: Record<string, unknown>): Promise<ApiResult<AgentDetail>> {
    return this.post<AgentDetail>("/web/config/agents", { action: "create", name, data });
  }
  async delete(name: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/agents", { action: "delete", name });
  }
  async setDefault(name: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/agents", { action: "set_default", name });
  }
}

export class SkillConfigApi extends BaseApi {
  async list(): Promise<ApiResult<SkillInfo[]>> {
    return this.post<SkillInfo[]>("/web/config/skills", { action: "list" });
  }
  async get(name: string): Promise<ApiResult<SkillInfo>> {
    return this.post<SkillInfo>("/web/config/skills", { action: "get", name });
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
    return this.post<McpServerInfo[]>("/web/config/mcp", { action: "list" });
  }
  async get(name: string): Promise<ApiResult<McpServerDetail>> {
    return this.post<McpServerDetail>("/web/config/mcp", { action: "get", name });
  }
  async create(name: string, data: Record<string, unknown>): Promise<ApiResult<McpServerInfo>> {
    return this.post<McpServerInfo>("/web/config/mcp", { action: "create", name, data });
  }
  async set(name: string, data: Record<string, unknown>): Promise<ApiResult<McpServerInfo>> {
    return this.post<McpServerInfo>("/web/config/mcp", { action: "set", name, data });
  }
  async delete(name: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/mcp", { action: "delete", name });
  }
  async enable(name: string): Promise<ApiResult<McpServerInfo>> {
    return this.post<McpServerInfo>("/web/config/mcp", { action: "enable", name });
  }
  async disable(name: string): Promise<ApiResult<McpServerInfo>> {
    return this.post<McpServerInfo>("/web/config/mcp", { action: "disable", name });
  }
  async test(name: string): Promise<ApiResult<{ success: boolean; error?: string }>> {
    return this.post("/web/config/mcp", { action: "test", name });
  }
  async testUrl(url: string): Promise<ApiResult<{ success: boolean; error?: string }>> {
    return this.post("/web/config/mcp", { action: "test_url", url });
  }
  async inspect(name: string): Promise<ApiResult<McpInspectResult>> {
    return this.post<McpInspectResult>("/web/config/mcp", { action: "inspect", name });
  }
  async listTools(name: string): Promise<ApiResult<McpToolInfo[]>> {
    return this.post<McpToolInfo[]>("/web/config/mcp", { action: "list_tools", name });
  }
}
