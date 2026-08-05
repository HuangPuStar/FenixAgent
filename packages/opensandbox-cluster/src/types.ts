export interface ClusterConfig {
  port: number;
  host: string;
  databasePath: string;
  clusterServiceApiKey: string;
  serverApiKeyEncryptionKey: Uint8Array;
  proxyConnectTimeoutMs: number;
  proxyResponseTimeoutMs: number;
}

export interface HealthResponse {
  status: "healthy";
}
