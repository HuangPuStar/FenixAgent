# 配置资源系统

> 涉及模块：Provider、Model、Skill、MCP Server、ExpertConfig、ConnectorDefinition、UserConfig、跨组织共享
>
> **状态：目标架构（未实现）**。本文描述配置资源的职责和管理边界；通用版本语义以 [通用资源版本控制](./07-versioning.md) 为准。

## 概述

配置资源系统管理 Agent 运行所需的可复用资源。资源保存在各自的业务表中，按组织隔离，并通过明确的依赖关系组合为 AgentConfig。每类资源拥有自己的字段、校验和生命周期，不使用一张通用 JSON 资源表承载业务数据。

## 资源目录

| 资源 | 管理内容 | 使用方 |
|------|----------|--------|
| Provider | AI 服务商协议、地址和密钥引用 | Model |
| Model | 服务商模型标识及能力元数据 | ExpertConfig |
| Skill | `SKILL.md` 与附属文件 | ExpertConfig |
| McpServer | 外部工具服务的连接配置 | ExpertConfig |
| ExpertConfig | 专家的模型、Skill、MCP 和行为配置 | AgentConfig |
| ConnectorDefinition | 可复用连接器定义 | AgentConfig |
| UserConfig | 用户偏好，例如默认 Agent | 用户自身 |

Model 与 Provider 详见 [模型配置](./06-config-provider.md)，Skill 详见 [Skills 配置](./06-config-skills.md)，MCP 详见 [MCP 配置](./06-config-mcp.md)，Hindsight 集成详见 [Hindsight 记忆](./06-config-hindsight.md)。

## 组合关系

```text
AgentConfig
├── ExpertConfig
│   ├── Skill
│   ├── McpServer
│   └── Model
│       └── Provider
└── ConnectorDefinition
```

资源关系由具体业务字段表达。多个上游可以共享同一下游，但禁止反向、自引用和未声明的跨类型关联。UserConfig 是用户偏好，不进入 AgentConfig 的资源依赖图。

## 通用管理边界

- 每类资源由自己的 service 和 repository 管理，业务校验留在所属领域；
- 固定结构使用 PostgreSQL 类型字段和关系表，只有天然开放的配置片段才使用 JSON；
- 删除或停用前必须检查仍在使用该资源的上游，行为由具体资源定义；
- Secret 只保存引用，实际值在受控运行时边界解析；
- 资源列表、详情和引用选择器必须按组织与授权过滤；
- 运行时状态、探测结果和缓存不混入资源定义。

需要版本化的具体资源复用 [通用资源版本控制](./07-versioning.md)，但资源的字段、子对象、业务不变量和运行时转换仍由各自领域负责。

## 跨组织共享

资源默认仅本组织可见。允许公开的资源可以被其他组织引用，但公开读取不授予修改、删除或转授权能力。跨组织引用必须保留来源组织，并在保存和运行时重新校验授权。
