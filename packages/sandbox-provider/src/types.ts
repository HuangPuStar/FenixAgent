export type SandboxTemplate = {
  type: "image";
  value: string;
};

export type SandboxVolume = {
  name: string;
  source?: string;
  target: string;
  readOnly?: boolean;
};

export type SandboxResources = {
  cpu: number;
  memoryMb: number;
  diskGb: number;
  gpuCount: number;
  environment: Record<string, string>;
  volumes: SandboxVolume[];
};

export type SandboxResourceOverrides = Partial<SandboxResources>;

export type SandboxProviderExtra = Record<string, unknown>;

export type SandboxCreateInput = {
  sandboxId: string;
  poolId: string;
  template: SandboxTemplate;
  resources: SandboxResources;
  providerExtra?: SandboxProviderExtra;
};

export type ProviderSandboxStatus = "creating" | "ready" | "stopped" | "error";

export type SandboxRef = {
  sandboxId: string;
  status: ProviderSandboxStatus;
  payload?: unknown;
};
