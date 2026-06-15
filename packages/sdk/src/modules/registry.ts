import { BaseApi } from "../base";
import type { ApiResult } from "../result";

export interface MachineRecord {
  id: string;
  agentName: string;
  name: string | null;
  status: string;
  machineInfo: { hostname?: string; ip?: string; os?: string; arch?: string } | null;
  labels: string[] | null;
  registeredAt: number;
  lastHeartbeatAt: number | null;
}

export interface MachineListResponse {
  data: MachineRecord[];
  total: number;
}

export interface MachineDetailResponse {
  data: MachineRecord & { recentEvents: unknown[] };
}

export class RegistryApi extends BaseApi {
  async list(query?: {
    status?: string;
    labels?: string;
    limit?: number;
    offset?: number;
  }): Promise<ApiResult<MachineListResponse>> {
    return this._get<MachineListResponse>("/web/registry/machines", { query });
  }

  async get(id: string): Promise<ApiResult<MachineDetailResponse>> {
    return this._get<MachineDetailResponse>("/web/registry/machines/:id", { params: { id } });
  }

  async events(
    id: string,
    query?: { limit?: number; offset?: number },
  ): Promise<ApiResult<{ data: unknown[]; total: number }>> {
    return this._get<{ data: unknown[]; total: number }>("/web/registry/machines/:id/events", {
      params: { id },
      query,
    });
  }
}
