export type OpenSandboxClusterProviderConfig = {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
  createTimeoutMs: number;
  resumeTimeoutMs: number;
  destroyTimeoutMs: number;
};

export type ClusterAllocationResponse = {
  sandbox_id: string;
  pool_id: string;
  server_id: string;
  proxy_url: string;
};

export type OpenSandboxResponse = {
  id: string;
  status?: string;
  [key: string]: unknown;
};
