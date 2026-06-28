import openapi from "@elysiajs/openapi";
import * as z from "zod/v4";

const API_OPENAPI_PATH = "/docs/openapi/external";
const API_OPENAPI_SPEC_PATH = `${API_OPENAPI_PATH}/json`;
const WEB_OPENAPI_PATH = "/docs/openapi/web";
const WEB_OPENAPI_SPEC_PATH = `${WEB_OPENAPI_PATH}/json`;

const EXTERNAL_OPENAPI_TAGS = [
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
];

const WEB_OPENAPI_TAGS = [
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
    name: "Sessions",
    description: "会话管理与事件历史查询。",
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
    name: "Organizations",
    description: "组织、成员和 API Key 管理。",
  },
  {
    name: "Knowledge",
    description: "知识库与知识资源管理。",
  },
  {
    name: "Channels",
    description: "IM 通道绑定与消息路由配置。",
  },
  {
    name: "Registry",
    description: "机器注册表管理，包括机器列表、详情与事件历史查询。",
  },
  {
    name: "Meta Agent",
    description: "Meta Agent 自举与运行环境确保接口。",
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
];

const EXTERNAL_DOC_TAG_NAMES = EXTERNAL_OPENAPI_TAGS.map((tag) => tag.name);
const WEB_DOC_TAG_NAMES = WEB_OPENAPI_TAGS.map((tag) => tag.name);

const DOC_EXCLUDED_PATHS: Array<string | RegExp> = [
  "/health",
  API_OPENAPI_PATH,
  API_OPENAPI_SPEC_PATH,
  WEB_OPENAPI_PATH,
  WEB_OPENAPI_SPEC_PATH,
];

/**
 * 创建对外 API 文档插件，避免在入口文件堆积 OpenAPI 细节。
 */
export function createExternalOpenApiPlugin(version: string) {
  return openapi({
    documentation: {
      info: {
        title: "Fenix External API",
        version,
        description: "面向外部系统的 API 文档。",
      },
      tags: EXTERNAL_OPENAPI_TAGS,
    },
    provider: "scalar",
    scalar: {
      url: API_OPENAPI_SPEC_PATH,
    },
    mapJsonSchema: {
      zod: z.toJSONSchema,
    },
    exclude: {
      paths: DOC_EXCLUDED_PATHS,
      tags: WEB_DOC_TAG_NAMES,
    },
    path: API_OPENAPI_PATH,
    specPath: API_OPENAPI_SPEC_PATH,
  });
}

/**
 * 创建控制台 Web API 文档插件，保持入口只负责组装应用。
 */
export function createWebOpenApiPlugin(version: string) {
  return openapi({
    documentation: {
      info: {
        title: "Fenix Web API",
        version,
        description: "控制台内部 /web 及平台接口文档。",
      },
      tags: WEB_OPENAPI_TAGS,
    },
    provider: "scalar",
    scalar: {
      url: WEB_OPENAPI_SPEC_PATH,
    },
    mapJsonSchema: {
      zod: z.toJSONSchema,
    },
    exclude: {
      paths: DOC_EXCLUDED_PATHS,
      tags: EXTERNAL_DOC_TAG_NAMES,
    },
    path: WEB_OPENAPI_PATH,
    specPath: WEB_OPENAPI_SPEC_PATH,
  });
}
