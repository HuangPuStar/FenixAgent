/** Public pool configuration returned by Cluster. */
export interface Pool {
  id: string;
  name: string;
  status: string;
  schedulingMode: "count" | "resources";
  defaultLeaseSeconds: number | null;
  maxLeaseSeconds: number | null;
  currentSandboxes: number;
  capacitySandboxes: number;
  availableSandboxes: number;
}
/** Public node configuration; credentials are supplied only when editing. */
export interface Server {
  id: string;
  poolId: string;
  name: string;
  transportMode: "direct" | "tunnel";
  baseUrl: string;
  workspaceRoot: string;
  status: string;
  healthStatus: string;
  lastError: string | null;
  maxSandboxes: number | null;
  currentSandboxes: number;
  cpuCapacity: number | null;
  memoryCapacityMb: number | null;
  diskCapacityGb: number | null;
  gpuCapacity: number | null;
  allocatedResources: Resources | null;
}
/** Capacity values in cores, MB, GB and GPU count. */
export interface Resources {
  cpu: number;
  memoryMb: number;
  diskGb: number;
  gpuCount: number;
}
/** Durable allocation view shared by both scheduling modes. */
export interface Allocation {
  sandbox_id: string;
  pool_id: string;
  server_id: string;
  allocation_mode: "count" | "resources";
  allocation_etag: string;
  state: string;
  provider_sandbox_id: string | null;
  expires_at: number | null;
  proxy_url: string;
  resources: { [K in keyof Resources]: number | null } | null;
  created_at: number;
}
/** Paged management query. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
/** Common create form translated at the protocol boundary. */
export interface SandboxInput {
  sandbox_id: string;
  lease_seconds?: number;
  resources: Resources & {
    environment?: Record<string, string>;
    volumes?: { name: string; source: string; target: string; readOnly?: boolean }[];
  };
  sandbox: { image: { uri: string }; entrypoint?: string[]; metadata?: Record<string, string> };
}
