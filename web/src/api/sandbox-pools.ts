import { request } from "@/src/api/request";

export interface SandboxPoolOption {
  id: string;
  name: string;
}

export interface SandboxPoolOptionsResponse {
  enabled: boolean;
  pools: SandboxPoolOption[];
}

export const sandboxPoolApi = {
  list: () => request<SandboxPoolOptionsResponse>("/web/config/sandbox-pools", { method: "GET" }),
};
