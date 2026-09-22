import { ApiError, request, unwrap } from "@fenix/web-runtime/api/request";
import { getAdminKey } from "@fenix/web-runtime/lib/admin-key";

export interface SandboxResources {
  cpu: number;
  memoryMb: number;
  diskGb: number;
  gpuCount: number;
  environment: Record<string, string>;
  volumes: Array<{ name: string; source?: string; target: string; readOnly?: boolean }>;
}

export interface SandboxPool {
  id: string;
  organizationId: string | null;
  organizationName: string | null;
  name: string;
  providerKey: string;
  image: string;
  defaultResources: SandboxResources;
  extra: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxInstance {
  id: string;
  machineId: string;
  providerKey: string;
  sandboxPoolId: string;
  userId: string;
  externalSandboxId: string | null;
  status: string;
  resolvedConfig: Record<string, unknown>;
  resourceOverrides: SandboxResourcePatch | null;
  providerPayload: unknown;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string; email: string };
  machine: { id: string; name: string; status: string; lastHeartbeatAt: string | null };
}

export interface SandboxResourcePatch {
  cpu?: number | null;
  memoryMb?: number | null;
  diskGb?: number | null;
  gpuCount?: number | null;
}

export interface SandboxInstanceList {
  items: SandboxInstance[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ClusterPool {
  id: string;
  name: string;
  status: string;
  currentSandboxes?: number;
  capacitySandboxes?: number;
  availableSandboxes?: number;
}

export interface ClusterServer {
  id: string;
  poolId: string;
  name: string;
  baseUrl: string;
  workspaceRoot: string;
  maxSandboxes: number;
  status: string;
  transportMode: "direct" | "tunnel";
  routeHost: string | null;
  healthStatus: string;
  lastHealthAt: number | null;
  lastError: string | null;
  currentSandboxes: number;
}

export interface RemoteSandbox {
  id: string;
  image?: string | { uri?: string };
  status: {
    state: string;
    reason?: string | null;
    message?: string | null;
    lastTransitionAt?: string | null;
  };
  createdAt: string;
  [key: string]: unknown;
}

export interface RemoteSandboxList {
  items: RemoteSandbox[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number; hasNextPage: boolean };
}

export interface SandboxCommandBody {
  command: string;
  cwd?: string;
  background?: boolean;
  timeout?: number;
}

export type SandboxRebuildRequest = {
  sandboxPoolId: string;
  instanceIds?: string[];
  userIds?: string[];
  dryRun?: boolean;
};

export function buildSandboxResourcePatch(
  input: Partial<Record<keyof SandboxResourcePatch, string>>,
): SandboxResourcePatch {
  const patch: SandboxResourcePatch = {};
  for (const key of ["cpu", "memoryMb", "diskGb", "gpuCount"] as const) {
    const rawValue = input[key];
    if (typeof rawValue === "string" && rawValue.trim() !== "") {
      const value = Number(rawValue);
      if (Number.isFinite(value) && value > (key === "gpuCount" ? -1 : 0)) patch[key] = value;
    } else if (typeof rawValue === "string" && rawValue.trim() === "") {
      patch[key] = null;
    }
  }
  return patch;
}

export function buildSandboxRebuildRequest(input: {
  poolId: string;
  scope: "pool" | "instance" | "user";
  instanceId?: string;
  userId?: string;
}): SandboxRebuildRequest {
  if (input.scope === "instance") return { sandboxPoolId: input.poolId, instanceIds: [input.instanceId!] };
  if (input.scope === "user") return { sandboxPoolId: input.poolId, userIds: [input.userId!] };
  return { sandboxPoolId: input.poolId };
}

const adminOptions = () => ({ bearerToken: getAdminKey() ?? undefined });

export const systemSandboxApi = {
  listPools: () => unwrap(request<SandboxPool[]>("/api/system/sandbox-pools", adminOptions())),
  createPool: (body: Omit<SandboxPool, "createdAt" | "updatedAt" | "organizationName">) =>
    unwrap(request<SandboxPool>("/api/system/sandbox-pools", { ...adminOptions(), method: "POST", body })),
  updatePool: (id: string, body: Omit<SandboxPool, "id" | "createdAt" | "updatedAt" | "organizationName">) =>
    unwrap(
      request<SandboxPool>("/api/system/sandbox-pools/:poolId", {
        ...adminOptions(),
        method: "PUT",
        params: { poolId: id },
        body,
      }),
    ),
  getPool: (id: string) =>
    unwrap(request<SandboxPool>("/api/system/sandbox-pools/:poolId", { ...adminOptions(), params: { poolId: id } })),
  deletePool: (id: string) =>
    unwrap(
      request<void>("/api/system/sandbox-pools/:poolId", {
        ...adminOptions(),
        method: "DELETE",
        params: { poolId: id },
      }),
    ),
  listInstances: (poolId?: string) =>
    unwrap(
      request<SandboxInstanceList>("/api/system/sandbox-instances", {
        ...adminOptions(),
        query: poolId ? { sandbox_pool_id: poolId, page: 1, page_size: 200 } : { page: 1, page_size: 200 },
      }),
    ),
  getInstance: (id: string) =>
    unwrap(
      request<SandboxInstance>("/api/system/sandbox-instances/:instanceId", {
        ...adminOptions(),
        params: { instanceId: id },
      }),
    ),
  updateInstance: (id: string, resourceOverrides: SandboxResourcePatch) =>
    unwrap(
      request<SandboxInstance>("/api/system/sandbox-instances/:instanceId", {
        ...adminOptions(),
        method: "PUT",
        params: { instanceId: id },
        body: { resourceOverrides },
      }),
    ),
  deleteInstance: (id: string) =>
    unwrap(
      request<void>("/api/system/sandbox-instances/:instanceId", {
        ...adminOptions(),
        method: "DELETE",
        params: { instanceId: id },
      }),
    ),
  rebuild: (body: SandboxRebuildRequest) =>
    unwrap(request<unknown>("/api/system/sandbox-instances/rebuild", { ...adminOptions(), method: "POST", body })),
  cluster: {
    listPools: () => unwrap(request<ClusterPool[]>("/api/system/sandbox-cluster/pools", adminOptions())),
    createPool: (body: { id: string; name: string; status?: string }) =>
      unwrap(request<ClusterPool>("/api/system/sandbox-cluster/pools", { ...adminOptions(), method: "POST", body })),
    updatePool: (id: string, body: { name?: string; status?: string }) =>
      unwrap(
        request<ClusterPool>("/api/system/sandbox-cluster/pools/:poolId", {
          ...adminOptions(),
          method: "PUT",
          params: { poolId: id },
          body,
        }),
      ),
    deletePool: (id: string) =>
      unwrap(
        request<void>("/api/system/sandbox-cluster/pools/:poolId", {
          ...adminOptions(),
          method: "DELETE",
          params: { poolId: id },
        }),
      ),
    listServers: (poolId?: string) =>
      unwrap(
        request<ClusterServer[]>("/api/system/sandbox-cluster/servers", {
          ...adminOptions(),
          query: poolId ? { pool_id: poolId } : undefined,
        }),
      ),
    createServer: (body: Record<string, unknown>) =>
      unwrap(
        request<ClusterServer>("/api/system/sandbox-cluster/servers", { ...adminOptions(), method: "POST", body }),
      ),
    updateServer: (id: string, body: Record<string, unknown>) =>
      unwrap(
        request<ClusterServer>("/api/system/sandbox-cluster/servers/:serverId", {
          ...adminOptions(),
          method: "PUT",
          params: { serverId: id },
          body,
        }),
      ),
    deleteServer: (id: string) =>
      unwrap(
        request<void>("/api/system/sandbox-cluster/servers/:serverId", {
          ...adminOptions(),
          method: "DELETE",
          params: { serverId: id },
        }),
      ),
    healthCheck: (id: string) =>
      unwrap(
        request<ClusterServer>("/api/system/sandbox-cluster/servers/:serverId/health-check", {
          ...adminOptions(),
          method: "POST",
          params: { serverId: id },
        }),
      ),
    prepareTunnel: (id: string) =>
      unwrap(
        request<unknown>("/api/system/sandbox-cluster/servers/:serverId/tunnel", {
          ...adminOptions(),
          method: "PUT",
          params: { serverId: id },
        }),
      ),
    downloadTunnelConfig: async (id: string) => {
      const response = await fetch(`/api/system/sandbox-cluster/servers/${encodeURIComponent(id)}/tunnel/frpc.toml`, {
        headers: { Authorization: `Bearer ${getAdminKey() ?? ""}` },
      });
      // 该端点直接回 toml 文本（非 /web 的 { success, data } 信封），故不经 request()；
      // 三处裸 fetch 的失败语义统一由 buildStreamError 归一。
      if (!response.ok) throw await buildStreamError(response);
      return response.text();
    },
  },
  server: {
    listSandboxes: (
      serverId: string,
      query: { state?: string; metadata?: string; page?: number; page_size?: number } = {},
    ) =>
      unwrap(
        request<RemoteSandboxList>("/api/system/sandbox-server/servers/:serverId/sandboxes", {
          ...adminOptions(),
          params: { serverId },
          query: { page: 1, page_size: 200, ...query },
        }),
      ),
    getSandbox: (serverId: string, sandboxId: string) =>
      unwrap(
        request<RemoteSandbox>("/api/system/sandbox-server/servers/:serverId/sandboxes/:sandboxId", {
          ...adminOptions(),
          params: { serverId, sandboxId },
        }),
      ),
    getDiagnostics: async (serverId: string, sandboxId: string) => {
      const response = await fetch(
        `/api/system/sandbox-server/servers/${encodeURIComponent(serverId)}/sandboxes/${encodeURIComponent(sandboxId)}/diagnostics`,
        { headers: { Authorization: `Bearer ${getAdminKey() ?? ""}` } },
      );
      if (!response.ok) throw await buildStreamError(response);
      return response.text();
    },
    executeCommand: async (serverId: string, sandboxId: string, body: SandboxCommandBody, signal: AbortSignal) => {
      const response = await fetch(
        `/api/system/sandbox-server/servers/${encodeURIComponent(serverId)}/sandboxes/${encodeURIComponent(sandboxId)}/commands`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${getAdminKey() ?? ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        },
      );
      if (!response.ok) throw await buildStreamError(response);
      return response;
    },
  },
};

/**
 * toast description 的字符上限。
 *
 * 信封里的 message 是后端有意给的信息，本层不重写，但要封顶：后端 `extractClusterErrorMessage`
 * （`src/server/services/sandbox-cluster-client.ts`）在上游返回非 JSON 时会把上游响应正文**原样**
 * 当成 message 透传，上游是网关页时就是整段 HTML——不封顶等于把同一类长正文换个字段灌进 toast。
 * 截断只影响极端长文，正常业务错误（如 "sandbox not found"）逐字保留。
 */
const MAX_ERROR_MESSAGE_LENGTH = 200;

/**
 * 文本 / 流式端点的失败归一：一律抛 `ApiError`，与同文件其余经 `unwrap(request())` 的方法同一失败语义。
 *
 * 为什么这三个方法仍用裸 `fetch`：端点直接回文本或 SSE（非 `/web` 的 `{ success, data }` 信封），
 * `request()` 只解 JSON 信封、且非 JSON 分支会把 body 当文本消费掉，拿不到原始文本 / 流。这与前端规范
 * 5.3「非标准响应适配」记的「已知能力缺口」是同一处缺口（修法在 `request()` 一侧），本文件只是它在沙箱
 * 域内的收容点——缺口补上后这三个方法应退回 `request()` / `unwrap()`。
 *
 * code 取服务端 `{ error: { code, message } }` 信封里的稳定错误码（与 `unwrap()` 的取码来源相同）；
 * 信封缺失（网关 / 代理直接回 HTML 等）时退化为 UNKNOWN——不在本层再写一份 status→code 映射，
 * 否则同一前端会出现第二套取码规则。
 *
 * message 只作诊断上下文（调用方拿它当 toast 的 description），面向用户的标题仍由调用方 `t()` 提供。
 * 因此**不把响应正文当文案**：非信封响应退化为状态码文案（`HTTP ${status}`），原始正文只用于尝试解析
 * 信封，解析失败即丢弃——否则网关 HTML 会整段出现在 toast 里，长文本还会撑爆 description。
 * 信封内的 message 才回显，并按 `MAX_ERROR_MESSAGE_LENGTH` 封顶（见该常量说明）。
 *
 * 三处 fetch 都不传 `credentials`：`/api/system/*` 的守卫只读 `Authorization` 头
 * （`apps/server/src/plugins/system-api-auth.ts`），不认 session cookie，补 `include` 不会改变鉴权结果，
 * 因此维持不发送 cookie（更小的凭据暴露面），这不是缺陷。
 */
async function buildStreamError(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  const envelope = parseErrorEnvelope(text);
  const message = envelope.message ? truncateErrorMessage(envelope.message) : `HTTP ${response.status}`;
  return new ApiError(message, envelope.code ?? "UNKNOWN");
}

/** 超长诊断文案截断并加省略号：调用方只展示，不需要完整正文。 */
function truncateErrorMessage(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : message;
}

/** 解析 `{ error: { code, message } }` 信封；非该形状（网关 HTML 等）返回空对象，由 `buildStreamError` 用状态码文案兜底。 */
function parseErrorEnvelope(text: string): { code?: string; message?: string } {
  try {
    const payload: unknown = JSON.parse(text);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
    const error = (payload as Record<string, unknown>).error;
    if (typeof error !== "object" || error === null || Array.isArray(error)) return {};
    const { code, message } = error as Record<string, unknown>;
    return {
      code: typeof code === "string" && code.trim() ? code : undefined,
      message: typeof message === "string" && message.trim() ? message : undefined,
    };
  } catch {
    // 非 JSON 错误体（网关 HTML 等）：信封缺失，code 落 UNKNOWN、message 由状态码文案兜底，正文不回显。
    return {};
  }
}
