import { BaseApi } from "../base";
import type { ApiResult } from "../result";

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

interface OrgDetail extends OrgInfo {
  members: Array<{
    id: string;
    userId: string;
    role: string;
    user: { id: string; name: string; email: string };
  }>;
}

interface OrgMember {
  id: string;
  userId: string;
  role: string;
}

interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  expiresAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export class OrganizationApi extends BaseApi {
  async list(): Promise<ApiResult<OrgInfo[]>> {
    return this.post<OrgInfo[]>("/web/organizations", { action: "list" });
  }
  async get(organizationId: string): Promise<ApiResult<OrgDetail>> {
    return this.post<OrgDetail>("/web/organizations", { action: "get", organizationId });
  }
  async getFull(organizationId: string): Promise<ApiResult<OrgDetail>> {
    return this.post<OrgDetail>("/web/organizations", { action: "get-full", organizationId });
  }
  async create(body: { name: string; slug?: string }): Promise<ApiResult<OrgInfo>> {
    return this.post<OrgInfo>("/web/organizations", { action: "create", ...body });
  }
  async update(organizationId: string, body: { name?: string; slug?: string }): Promise<ApiResult<OrgInfo>> {
    return this.post<OrgInfo>("/web/organizations", { action: "update", organizationId, ...body });
  }
  async delete(organizationId: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/organizations", { action: "delete", organizationId });
  }
  async setActive(organizationId: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/organizations", { action: "set-active", organizationId });
  }
  async listMembers(organizationId: string): Promise<ApiResult<OrgMember[]>> {
    return this.post<OrgMember[]>("/web/organizations", { action: "list-members", organizationId });
  }
  async searchUsers(
    query: string,
  ): Promise<ApiResult<Array<{ id: string; name: string; email: string; image?: string }>>> {
    return this.post("/web/organizations", { action: "search-users", query });
  }
  async addMember(organizationId: string, body: { email: string; role: string }): Promise<ApiResult<OrgMember>> {
    return this.post<OrgMember>("/web/organizations", { action: "add-member", organizationId, ...body });
  }
  async removeMember(organizationId: string, memberId: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/organizations", { action: "remove-member", organizationId, memberId });
  }
  async updateRole(organizationId: string, memberId: string, role: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/organizations", { action: "update-role", organizationId, memberId, role });
  }
}

export class ApiKeyApi extends BaseApi {
  async list(): Promise<ApiResult<ApiKeyInfo[]>> {
    return this.post<ApiKeyInfo[]>("/web/apiKeys", { action: "list" });
  }
  async create(body: { name: string; expiresIn?: number }): Promise<ApiResult<{ key: string }>> {
    return this.post<{ key: string }>("/web/apiKeys", { action: "create", ...body });
  }
  async delete(id: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/apiKeys", { action: "delete", id });
  }
  async update(id: string, data: Record<string, unknown>): Promise<ApiResult<ApiKeyInfo>> {
    return this.post<ApiKeyInfo>("/web/apiKeys", { action: "update", id, data });
  }
}
