export interface ClusterConfig {
  port: number;
  host: string;
  databasePath: string;
  clusterServiceApiKey: string;
  serverApiKeyEncryptionKey: Uint8Array;
  proxyConnectTimeoutMs: number;
  proxyResponseTimeoutMs: number;
  frpPluginPort: number;
  frpPublicAddress: string;
  frpBindPort: number;
  frpInternalUrl: string;
  frpToken: string;
  frpConnectionStaleMs: number;
  frpHealthIntervalMs: number;
}

export interface HealthResponse {
  status: "healthy";
}
