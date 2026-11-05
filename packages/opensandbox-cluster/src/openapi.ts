import { type ElysiaOpenAPIConfig, openapi } from "@elysiajs/openapi";
import { clusterOpenApiSchemas } from "./schemas/openapi-schemas";

type Documentation = NonNullable<ElysiaOpenAPIConfig["documentation"]>;
type Paths = NonNullable<Documentation["paths"]>;
type Operation = NonNullable<NonNullable<Paths[string]>["get"]>;
type Parameter = NonNullable<Operation["parameters"]>[number];
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, array = false) => ({
  "application/json": { schema: array ? { type: "array" as const, items: ref(name) } : ref(name) },
});
function operation(tag: string, summary: string, output: string, options: Partial<Operation> = {}): Operation {
  return {
    tags: [tag],
    summary,
    responses: {
      200: { description: "成功", content: json(output) },
      400: { description: "参数无效", content: json("Error") },
      401: { description: "认证失败", content: json("Error") },
      404: { description: "资源不存在", content: json("Error") },
      409: { description: "容量不足或状态冲突", content: json("Error") },
    },
    ...options,
  };
}
const body = (name: string) => ({ required: true, content: json(name) });
const pathParam = (name: string): Parameter => ({ name, in: "path", required: true, schema: { type: "string" } });
const conditional = (name: string, description: string): Parameter => ({
  name,
  in: "header",
  description,
  schema: { type: "string" },
});
const pools = "资源池",
  servers = "节点",
  allocations = "数量分配",
  tunnels = "隧道";

// These v1 endpoints validate manually. Documenting them separately preserves their published validation behavior.
const paths: Paths = {
  "/health": {
    get: {
      summary: "服务健康检查",
      tags: ["健康"],
      security: [],
      responses: {
        200: {
          description: "服务正常",
          content: {
            "application/json": {
              schema: { type: "object", properties: { status: { type: "string", enum: ["healthy"] } } },
            },
          },
        },
      },
    },
  },
  "/api/v1/pools": {
    get: operation(pools, "列出资源池", "Pool", {
      responses: {
        200: { description: "资源池列表", content: json("Pool", true) },
        401: { description: "认证失败", content: json("Error") },
      },
    }),
    post: operation(pools, "新建资源池", "PoolRecord", {
      requestBody: body("PoolInput"),
      description: "资源模式须配置默认和最大租期，单位秒，至少 60 秒。",
    }),
  },
  "/api/v1/pools/{poolId}": {
    parameters: [pathParam("poolId")],
    get: operation(pools, "查询资源池", "Pool"),
    put: operation(pools, "修改资源池", "PoolRecord", {
      requestBody: body("PoolUpdate"),
      description: "仅更新提供的字段；切换模式前须移除节点及非终态绑定。不存在时返回空响应。",
    }),
    delete: operation(pools, "删除空资源池", "PoolRecord", {
      description: "须先清除节点与沙盒记录。不存在时返回空响应。",
    }),
  },
  "/api/v1/servers": {
    get: operation(servers, "列出节点", "Server", {
      parameters: [{ name: "pool_id", in: "query", schema: { type: "string" } }],
      responses: {
        200: { description: "节点列表", content: json("Server", true) },
        401: { description: "认证失败", content: json("Error") },
      },
    }),
    post: operation(servers, "注册节点", "Server", {
      requestBody: body("ServerInput"),
      description: "direct 需 base_url；tunnel 通过 frpc 主动连接。数量池设置 max_sandboxes，资源池设置四项容量。",
    }),
  },
  "/api/v1/servers/{serverId}": {
    parameters: [pathParam("serverId")],
    get: operation(servers, "查询节点", "Server"),
    put: operation(servers, "修改节点", "Server", {
      requestBody: body("ServerUpdate"),
      description: "仅更新提供的字段；省略 api_key 可保留现有密钥。不存在时返回空响应。",
    }),
    delete: operation(servers, "删除空节点", "Server", {
      description: "须先清除沙盒记录。返回已删除节点记录，不存在时返回空响应。",
    }),
  },
  "/api/v1/servers/{serverId}/health-check": {
    parameters: [pathParam("serverId")],
    post: operation(servers, "检查节点健康", "Server"),
  },
  "/api/v1/servers/{serverId}/tunnel": {
    parameters: [pathParam("serverId")],
    put: operation(tunnels, "准备隧道连接", "Tunnel", {
      description: "direct 节点须先停止并通过离线检查。准备完成后下载 frpc.toml。",
    }),
  },
  "/api/v1/servers/{serverId}/tunnel/frpc.toml": {
    parameters: [pathParam("serverId")],
    get: operation(tunnels, "下载 frpc 配置", "Tunnel", {
      responses: {
        200: {
          description: "含节点凭证的 TOML 附件，请安全保存",
          content: { "application/toml": { schema: { type: "string" } } },
        },
        401: { description: "认证失败", content: json("Error") },
        404: { description: "节点不存在", content: json("Error") },
      },
    }),
  },
  "/api/v1/servers/{serverId}/tunnel/token": {
    parameters: [pathParam("serverId")],
    post: operation(tunnels, "轮换隧道凭证", "Tunnel", { description: "轮换后重新下载并部署 frpc.toml。" }),
    delete: operation(tunnels, "吊销隧道凭证", "Tunnel"),
  },
  "/api/v1/pools/{poolId}/sandboxes/{sandboxId}/allocate": {
    parameters: [pathParam("poolId"), pathParam("sandboxId")],
    post: operation(allocations, "分配数量模式绑定", "Allocation", {
      description: "只预留节点位置，不创建沙盒。同一业务 ID 幂等；通过返回的 proxy_url 调用 OpenSandbox 原生创建接口。",
      parameters: [conditional("If-None-Match", "设为 * 时拒绝已有绑定，并返回 allocation_etag 供条件创建使用。")],
    }),
  },
  "/api/v1/sandboxes/{sandboxId}/allocation": {
    parameters: [pathParam("sandboxId")],
    get: operation(allocations, "查询沙盒绑定", "Allocation"),
    delete: operation(allocations, "释放沙盒绑定", "Allocation", {
      description:
        "数量模式须先销毁远端沙盒，再释放绑定；返回已删除绑定记录。资源模式委托 Cluster 回收，返回生命周期记录。",
      parameters: [
        conditional("If-Match", '可选：allocation_etag 的 JSON 字符串，例如 "ey..."，防止释放已变化的数量绑定。'),
      ],
      responses: {
        200: {
          description: "释放结果；不存在时可能为空",
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        401: { description: "认证失败", content: json("Error") },
        409: { description: "绑定已变化", content: json("Error") },
      },
    }),
  },
};

/** Public API reference; business routes retain their own service-key checks. */
export function createOpenApi() {
  return openapi({
    // A dynamic page handler keeps Elysia's static-response compilation out of request logging.
    embedSpec: true,
    path: "/openapi",
    specPath: "/openapi/json",
    provider: "scalar",
    scalar: { url: "/openapi/json", persistAuth: false },
    exclude: { paths: ["/", "/assets/:file", "/skills/:name/download", "/internal/frp/plugin/:pathToken", "/*"] },
    documentation: {
      info: {
        title: "OpenSandbox Cluster API",
        version: "0.1.0",
        description:
          "资源池、节点及沙盒管理。请求使用 Authorization: Bearer <CLUSTER_SERVICE_API_KEY>。\n\n" +
          "CPU 使用核数（支持小数），内存 MB，硬盘 GB，GPU 数量。资源模式须在同一节点满足四项容量。\n\n" +
          "沙盒代理：{proxy_url}/v1/sandboxes/{provider_sandbox_id} 查询原生运行状态，追加 /pause、/resume 可 POST 暂停和恢复。" +
          "数量模式通过 POST {proxy_url}/v1/sandboxes 创建，DELETE {proxy_url}/v1/sandboxes/{provider_sandbox_id} 销毁。" +
          "沙盒子服务通过 {proxy_url}/v1/sandboxes/{provider_sandbox_id}/proxy/{port}/{path} 访问。" +
          "资源模式的创建与删除使用 v2 接口。",
      },
      tags: [pools, servers, allocations, tunnels, "沙盒", "资源", "健康"].map((name) => ({ name })),
      security: [{ BearerAuth: [] }],
      components: {
        securitySchemes: { BearerAuth: { type: "http", scheme: "bearer", description: "CLUSTER_SERVICE_API_KEY" } },
        schemas: clusterOpenApiSchemas,
      },
      paths,
    },
  });
}
