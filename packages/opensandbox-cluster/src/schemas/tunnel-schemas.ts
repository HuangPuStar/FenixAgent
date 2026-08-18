export interface TunnelServerInput {
  id: string;
  pool_id: string;
  name: string;
  workspace_root: string;
  api_key: string;
  max_sandboxes: number;
  status?: string;
}
