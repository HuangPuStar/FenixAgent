/**
 * Bridge / ACP 环境（worker）的对外报文形状。
 *
 * 为什么归本包：两个类型描述的是本包 `services/environment-acp.ts`（注册入口）与 `services/environment-core.ts`
 * （响应映射）的输入输出，宿主只是转发。它们此前声明在宿主 `apps/server/src/types/api.ts`，迁移后宿主已无
 * 消费方（实测：宿主 0 处引用）。
 */

/** 环境（worker）的注册响应体。 */
export interface EnvironmentResponse {
  id: string;
  machine_name: string | null;
  directory: string | null;
  branch: string | null;
  status: string;
  username: string | null;
  last_poll_at: number | null;
  worker_type?: string;
  capabilities?: Record<string, unknown> | null;
}

/** 环境（worker）的注册请求体。 */
export interface RegisterEnvironmentRequest {
  machine_name?: string;
  directory?: string;
  branch?: string;
  git_repo_url?: string;
  worker_type?: string;
  bridge_id?: string;
  capabilities?: Record<string, unknown>;
  metadata?: { worker_type?: string };
}
