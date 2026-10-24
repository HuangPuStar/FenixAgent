import openapi from "@elysiajs/openapi";
import Elysia from "elysia";
import * as z from "zod/v4";

const API_OPENAPI_PATH = "/docs/openapi/external";
const API_OPENAPI_SPEC_PATH = `${API_OPENAPI_PATH}/json`;
const WEB_OPENAPI_PATH = "/docs/openapi/web";
const WEB_OPENAPI_SPEC_PATH = `${WEB_OPENAPI_PATH}/json`;

/** 对外文档排除的路径及原因，同时匹配路径本身与子路径。 */
const EXTERNAL_API_EXCLUDED_PATHS: ReadonlyMap<string, string> = new Map([
  ["/api/system", "平台系统管理接口"],
  ["/api/auth", "控制台认证接口"],
]);

/** 通过 Elysia 的受保护扩展点读取宿主路由，避免使用子插件的局部路径。 */
class OpenApiRouteHost extends Elysia {
  /** 获取完成宿主前缀装配后的路由。 */
  getDocumentRoutes() {
    return this.getGlobalRoutes();
  }
}

const OPENAPI_TAGS = [
  {
    name: "External Model",
    description: "面向外部系统的 Provider 与 Model 配置管理接口。",
  },
  {
    name: "External Skill",
    description: "面向外部系统的 Skill 管理接口。",
  },
  {
    name: "External MCP",
    description: "面向外部系统的 MCP Server 配置管理接口。",
  },
  {
    name: "External AgentConfig",
    description: "面向外部系统的 Agent 配置 CRUD 接口。",
  },
  {
    name: "External Knowledge",
    description: "面向外部系统的知识库只读查询接口。",
  },
  {
    name: "External Instance",
    description: "面向外部系统的 Agent 实例连接接口。",
  },
  {
    name: "External Workspace",
    description: "面向外部系统的 Environment Workspace 文件接口。",
  },
  {
    name: "System User",
    description: "系统级用户管理接口，用于平台侧创建和查询全局用户。",
  },
  {
    name: "System Organization",
    description: "系统级组织管理接口，用于平台侧创建组织、查询组织和维护成员关系。",
  },
  {
    name: "System ApiKey",
    description: "系统级 API Key 管理接口，用于代指定用户签发兼容现有外部 API 的用户级 API key。",
  },
  {
    name: "System Sandbox",
    description: "系统级沙盒与 Cluster 基础设施管理接口。",
  },
  {
    name: "External Workflow",
    description: "面向外部系统的工作流执行接口，支持同步和异步两种模式。",
  },
  {
    name: "OpenAI Compatible",
    description: "兼容 OpenAI Chat Completions 协议的 Agent 对话接口。",
  },
  {
    name: "AgentConfig",
    description: "Agent 配置管理，包括列表查询、详情读取、创建、更新、删除和默认 Agent 设置。",
  },
  {
    name: "ProviderConfig",
    description: "Provider 配置管理，包括供应商凭证、连接测试和模型条目维护。",
  },
  {
    name: "ModelConfig",
    description: "模型配置管理，包括当前默认模型设置和可用模型列表刷新。",
  },
  {
    name: "SkillConfig",
    description: "Skill 配置管理，包括技能查询、编辑、删除与批量上传导入。",
  },
  {
    name: "McpConfig",
    description: "MCP 服务配置管理，包括服务增删改查、启停、测试和工具检查。",
  },
  {
    name: "Environments",
    description: "Agent 运行环境管理。",
  },
  {
    name: "Instances",
    description: "Agent 实例的启动、查询与销毁。",
  },
  {
    name: "Control",
    description: "会话控制接口，包括事件发送、控制指令和中断操作。",
  },
  {
    name: "Files",
    description: "环境工作区文件管理，包括文件内容读写、文件树、目录操作与批量删除。",
  },
  {
    name: "FS",
    description: "Workspace 文件系统管理，包括 workspace 全局文件树、目录浏览、文件读写与操作。",
  },
  {
    name: "Auth",
    description: "认证相关扩展接口，包括会话归属绑定等能力。",
  },
  {
    name: "Branding",
    description: "品牌展示配置接口，包括品牌名称和 Logo 资源获取。",
  },
  {
    name: "Tasks",
    description: "定时 HTTP 任务管理与执行日志查询。",
  },
  {
    name: "Tasks V2",
    description: "第二代定时任务管理接口，包括任务 CRUD、启停切换、手动触发与执行日志。",
  },
  {
    name: "Organizations",
    description: "组织、成员和 API Key 管理。",
  },
  {
    name: "Knowledge",
    description: "知识库与知识资源管理。",
  },
  {
    name: "Registry",
    description: "机器注册表管理，包括机器列表、详情与事件历史查询。",
  },
  {
    name: "Agent Sites",
    description: "Agent Sites 应用管理、文件上传、绑定关系维护与内部代理接口。",
  },
  {
    name: "Hindsight",
    description: "Hindsight 记忆服务状态查询与相关能力入口。",
  },
  {
    name: "ACP",
    description: "ACP 机器接入、Relay 中继与 Agent 列表查询接口。",
  },
  {
    name: "Code Session",
    description: "Code Session、Worker 状态同步、Bridge 接入与 Session Ingress 相关接口。",
  },
  {
    name: "Workflow Engine",
    description: "原生 DAG 工作流执行引擎相关接口。",
  },
  {
    name: "ProdView",
    description: "ProdView 配置与加载接口，包括配置 CRUD 和视图加载能力。",
  },
];

/** 文档归属只依赖最终挂载路径，对外文档统一应用排除规则。 */
function belongsToDocument(path: string, audience: "external" | "web"): boolean {
  if (audience === "web") return path.startsWith("/web/");
  if (!path.startsWith("/api/")) return false;
  for (const excludedPath of EXTERNAL_API_EXCLUDED_PATHS.keys()) {
    if (path === excludedPath || path.startsWith(`${excludedPath}/`)) return false;
  }
  return true;
}

/** 在文档生成前统一按完整路径筛选，标签元数据仅描述已收录接口的分组。 */
function createOpenApiPlugin(version: string, audience: "external" | "web") {
  const path = audience === "external" ? API_OPENAPI_PATH : WEB_OPENAPI_PATH;
  const specPath = audience === "external" ? API_OPENAPI_SPEC_PATH : WEB_OPENAPI_SPEC_PATH;
  const excludedPaths: string[] = [];
  const tags: typeof OPENAPI_TAGS = [];
  const plugin = new OpenApiRouteHost({ name: `fenix-openapi-${audience}` });

  plugin.onBeforeHandle(() => {
    const includedTags = new Set<string>();
    excludedPaths.length = 0;
    // openapi 1.4.15 的 exclude.paths 仅精确匹配字符串；请求时才能取得包含宿主前缀的完整路由。
    for (const route of plugin.getDocumentRoutes()) {
      if (!belongsToDocument(route.path, audience)) {
        excludedPaths.push(route.path);
      } else if (!route.hooks?.detail?.hide) {
        for (const tag of route.hooks?.detail?.tags ?? []) includedTags.add(tag);
      }
    }
    tags.length = 0;
    tags.push(...OPENAPI_TAGS.filter((tag) => includedTags.has(tag.name)));
  });

  return plugin.use(
    openapi({
      documentation: {
        info: {
          title: audience === "external" ? "Fenix External API" : "Fenix Web API",
          version,
          description:
            audience === "external" ? "面向外部系统的 API 文档，不包含系统管理接口。" : "控制台内部 /web 接口文档。",
        },
        tags,
      },
      provider: "scalar",
      scalar: {
        url: specPath,
      },
      mapJsonSchema: {
        zod: z.toJSONSchema,
      },
      exclude: {
        paths: excludedPaths,
      },
      path,
      specPath,
    }),
  );
}

/** 创建仅收录普通 /api 接口的对外文档。 */
export function createExternalOpenApiPlugin(version: string) {
  return createOpenApiPlugin(version, "external");
}

/** 创建仅收录 /web 接口的控制台文档。 */
export function createWebOpenApiPlugin(version: string) {
  return createOpenApiPlugin(version, "web");
}
