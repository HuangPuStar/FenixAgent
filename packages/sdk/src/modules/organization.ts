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
    user: { id: string; name: string; email: string; phoneNumber?: string | null };
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
    return this._get<OrgInfo[]>("/web/organizations");
  }
  async get(organizationId: string): Promise<ApiResult<OrgDetail>> {
    return this._get<OrgDetail>(`/web/organizations/${organizationId}`);
  }
  async getFull(organizationId: string): Promise<ApiResult<OrgDetail>> {
    return this._get<OrgDetail>(`/web/organizations/${organizationId}`);
  }
  async create(body: { name: string; slug?: string }): Promise<ApiResult<OrgInfo>> {
    return this.post<OrgInfo>("/web/organizations", body);
  }
  async update(organizationId: string, body: { name?: string; slug?: string }): Promise<ApiResult<OrgInfo>> {
    return this.put<OrgInfo>(`/web/organizations/${organizationId}`, body);
  }
  async delete(organizationId: string): Promise<ApiResult<{ success: boolean }>> {
    return this.del(`/web/organizations/${organizationId}`);
  }
  async setActive(organizationId: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post(`/web/organizations/${organizationId}/set-active`, {});
  }
  async listMembers(organizationId: string): Promise<ApiResult<OrgMember[]>> {
    return this._get<OrgMember[]>(`/web/organizations/${organizationId}/members`);
  }
  async addMember(organizationId: string, body: { identifier: string; role: string }): Promise<ApiResult<OrgMember>> {
    return this.post<OrgMember>(`/web/organizations/${organizationId}/members`, body);
  }
  async removeMember(organizationId: string, memberId: string): Promise<ApiResult<{ success: boolean }>> {
    return this.del(`/web/organizations/${organizationId}/members/${memberId}`);
  }
  async updateRole(organizationId: string, memberId: string, role: string): Promise<ApiResult<{ success: boolean }>> {
    return this.put(`/web/organizations/${organizationId}/members/${memberId}`, { role });
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
