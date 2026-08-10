import type { ClusterConfig } from "../types";

export function isValidClusterApiKey(request: Request, config: ClusterConfig): boolean {
  const header = request.headers.get("authorization");
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  return token === config.clusterServiceApiKey;
}
