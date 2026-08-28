import type { ClusterConfig } from "./types";

const required = (env: Record<string, string | undefined>, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const positiveInt = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

/** Parse process configuration and fail closed when authentication is not configured. */
export function loadConfig(env: Record<string, string | undefined> = process.env): ClusterConfig {
  const encryptionKey = required(env, "SERVER_API_KEY_ENCRYPTION_KEY");
  const keyBytes = new TextEncoder().encode(encryptionKey);
  if (keyBytes.length !== 32) {
    throw new Error("SERVER_API_KEY_ENCRYPTION_KEY must be exactly 32 UTF-8 bytes");
  }

  return {
    port: positiveInt(env.PORT, 8080, "PORT"),
    host: env.HOST ?? "0.0.0.0",
    databasePath: env.DATABASE_PATH ?? "/data/opensandbox-cluster.db",
    clusterServiceApiKey: required(env, "CLUSTER_SERVICE_API_KEY"),
    serverApiKeyEncryptionKey: keyBytes,
    proxyConnectTimeoutMs: positiveInt(env.PROXY_CONNECT_TIMEOUT_MS, 3000, "PROXY_CONNECT_TIMEOUT_MS"),
    proxyResponseTimeoutMs: positiveInt(env.PROXY_RESPONSE_TIMEOUT_MS, 120000, "PROXY_RESPONSE_TIMEOUT_MS"),
    frpPluginPort: positiveInt(env.FRP_PLUGIN_PORT, 8081, "FRP_PLUGIN_PORT"),
    frpPublicAddress: required(env, "FRP_PUBLIC_ADDRESS"),
    frpBindPort: positiveInt(env.FRP_BIND_PORT, 7000, "FRP_BIND_PORT"),
    frpInternalUrl: env.FRP_INTERNAL_URL ?? "http://frps:7080",
    frpToken: required(env, "FRP_TOKEN"),
    frpConnectionStaleMs: positiveInt(env.FRP_CONNECTION_STALE_MS, 40000, "FRP_CONNECTION_STALE_MS"),
    frpHealthIntervalMs: positiveInt(env.FRP_HEALTH_INTERVAL_MS, 30000, "FRP_HEALTH_INTERVAL_MS"),
  };
}
