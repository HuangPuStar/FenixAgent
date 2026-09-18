# EE 扩展架构

> 本文只面向 EE 和客户化扩展的设计与评审。CE 重构只需遵循[CE 目标架构与开发规范](./ce-ee-engineering-standards.md)，不需要阅读本文。

## 1. Git submodule 版本依赖边界

EE 根 `package.json` 将 `upstream/fenix/packages/*/*` 纳入 workspace，EE 代码仅从 CE 包公开入口导入。不得因为物理目录相邻而导入 `upstream/fenix/packages/**/src/**`。

CE 的公开包遵循语义化兼容承诺，并在每个 release tag 产出：变更日志、兼容性说明、migration manifest、环境变量变化和废弃项。

EE 对 CE 的引用必须固定为经过审查的不可变 tag/commit，不得修改 submodule 中的 CE 代码。具体升级步骤、校验命令和回滚流程不在本文规定。

## 2. 静态装配与依赖方向

EE 将自身包和 `upstream/fenix` 中的 CE 包纳入同一个 package-manager workspace。构建期同时扫描两侧受版本控制的 `fenix.module.ts`，生成仅含静态 import 的 registry；EE app 从 registry 与自己的 assembly profile 选择模块组合，不做运行时发现、下载或加载代码。

EE 依赖 CE 的方向只能是 `EE → CE`。EE package 和 app 只能使用 CE 的公开入口；CE 不得反向依赖 EE。

EE 可整体替换 Identity 与 AccessControl，但两者必须由 manifest 的精确 `dependsOn` 成套绑定。profile 混用不匹配的 Identity 与 AccessControl 时必须在 preflight 失败。

## 3. 平台、资源与数据库扩展

EE 的 Identity 与 AccessControl 保持两个包，作为一套平台实现被选择。EE 不得要求 CE 资源 service 读取 EE 的 member、role 或表；需要的通用授权能力应先成为稳定契约，客户专属能力保留在 EE 侧。

EE 不得修改 CE 拥有的表。EE 专属数据使用 EE schema 和扩展表，以 CE 稳定资源 ID 关联。EE 的 Drizzle 配置只列出 EE 自己拥有的 schema；如需外键引用 CE 表，只从 CE 公开 db 子路径导入该表作为外键目标，不 re-export 该表。

CE 与 EE 的 migration journal 必须隔离。EE migration 依赖 CE 表时，CE migration 必须先执行。

## 4. 前端扩展

EE 可以复用 CE 资源包公开的 `./web` API client、DTO 和组件；局部差异放在 EE 资源模块，整体页面流程差异由 EE 自己的资源页面和静态 route adapter 承担。不得复制整个 CE 页面或运行时注入路由。

整体 Shell 差异放在 EE 的 `apps/web/src/shell/`，包括企业首页、SSO 初始化、企业导航和布局。EE Shell 不通过覆盖 CE Shell 的局部 hook 实现差异；`apps/web` 仍是最终静态装配入口。

## 5. 扩展方案决策表

| 需求 | 放置与做法 | 禁止做法 |
| --- | --- | --- |
| 替换身份、租户、权限 | 在 platform 实现 `AccessControlModule`，app 静态替换 | 在资源 service 中读取 CE member/role 表 |
| `AccessControlModule` 缺能力 | 见 5.1 | 给现有接口塞客户专属 optional 字段或 `as any` |
| EE 对资源增加发布/审批/版本 | EE resources 包：自有 schema、状态机、Facade 覆盖/组合、route/web contribution；参考 §5.2 | 修改 CE 资源表加入 EE 字段，或复制 CE CRUD |
| 前端局部/整体差异 | EE 资源模块的 `web/` 复用 API client/组件或替换页面，在 app 静态选择 | fork 整个 CE web app、运行时注入路由 |
| 新增从未有过的业务功能 | 新建 EE resource/agent-runtime/web 模块，声明依赖、schema、routes、UI、测试 | 将功能塞进 platform-sdk 或 app.ts |
| 新引擎/RAG/MCP/Sandbox/部署目标 | 实现对应静态插件 SDK，app 选择 provider | 将 provider 特例写进 domain service |
| 更换存储 | 为 repository/provider port 新增 adapter，并完成迁移与 contract test | domain 内判断 DB 类型 |

### 5.1 扩展 `AccessControlModule` 的准则

先判断新需求的语义归属：

1. **所有资源都必须具备的基础授权语义**（如主体、写入归属、读写查询约束）进入下一版 `AccessControlModule`；CE 与 EE 实现随同 submodule 升级一起适配。这是明确的契约演进，不做兼容 shim。
2. **某领域独有的策略**（如 AgentConfig 发布审批人、Workflow 审批节点）在消费领域定义窄端口，例如 `AgentConfigApprovalPolicy`；EE access-control 实现可同时实现它，app 显式注入给 AgentConfig 模块。
3. **客户独有策略**放客户 EE 模块，不污染 CE 通用接口。

禁止通过 `accessControl as any`、`"method" in accessControl` 或全局 callback 注册表偷偷获得扩展能力。每个新增授权端口必须定义输入、输出、查询约束、拒绝语义、审计事件和 contract test。

#### 示例 1：EE 的 AgentConfig 发布审批（领域独有策略）

“谁可读取/修改/使用 AgentConfig”仍是基础 `AccessControlModule` 的职责；“谁可以将它发布到生产环境”只属于 AgentConfig 的发布领域，因此不应给所有资源的基础接口增加 `canPublish()`：

```ts
// packages/resources/agent-config/src/services/approval-policy.ts
export interface AgentConfigApprovalPolicy {
  authorizePublish(input: {
    actorId: string;
    agentConfigId: string;
    scope: unknown;
  }): Promise<void>;
}

// EE platform：同一个身份/授权实现可同时实现两个明确端口。
export class EnterpriseAccessControl
  implements AccessControlModule, AgentConfigApprovalPolicy {
  async authorizePublish(input): Promise<void> {
    // 检查企业工作空间的“配置发布人”权限；拒绝时写审计事件。
  }
}

// EE AgentConfig Facade：显式依赖窄端口，而不是向基础 AccessControlModule 强转。
export class EnterpriseAgentConfigFacade {
  constructor(
    private readonly accessControl: AccessControlModule,
    private readonly approvalPolicy: AgentConfigApprovalPolicy,
  ) {}
}

// apps/server：构建期明确装配。
const accessControl = new EnterpriseAccessControl();
const agentConfigs = new EnterpriseAgentConfigFacade(accessControl, accessControl);
```

这样 CE 不认识发布审批，其他资源也不会被迫实现无关方法；EE 仍可使用同一套企业身份数据。

#### 示例 2：甲方的合规审批（客户独有策略）

假设甲方 A 要求“涉及 `finance` 工作空间的 AgentConfig，必须由外部合规系统批准后才能发布”，而普通 EE 客户只需要企业发布人权限。甲方代码新增自己的模块：

```text
packages/resources/customer-a-agent-config-approval/
├── src/customer-a-approval-policy.ts  # 调用甲方合规系统、记录 approval ticket
└── web/                                # 显示合规状态与提交审批按钮
```

它实现同一个 `AgentConfigApprovalPolicy`，并在甲方版本的 `apps/server` 静态替换 EE 默认实现：

```ts
const accessControl = new EnterpriseAccessControl();
const approvalPolicy = new CustomerAAgentConfigApprovalPolicy({ complianceClient });
const agentConfigs = new EnterpriseAgentConfigFacade(accessControl, approvalPolicy);
```

CE 的 `AccessControlModule`、EE 的基础 AgentConfig CRUD 和其他客户均无需修改。若甲方需求将来被证明是多个客户共同需要的企业能力，再将该窄端口的默认实现上移到 EE；不要先把客户字段或方法加入 CE。

### 5.2 EE Resource 的 Version / Tag 问题

EE 需要对某些资源（如智能体）进行发布管理，会产生新的 Version/TAG。此时：

1. CE 公共 Facade 与跨资源关联只使用唯一、不可变的资源 ID；EE 为资源增加版本时，每个可引用版本拥有独立 ID，tag 或 version 只是 EE 模块内部指向该 ID 的别名，不得将 tag、version 或通用 params 加入 CE 公共接口。
2. 基础 list 仍列出具体资源记录，相当于列出所有版本对象；按逻辑资源聚合、列出 tag、解析 tag 等能力由 EE 资源模块扩展。
3. AgentConfig 等引用者只保存依赖版本的确定 ID；版本内容变化必须产生新 ID，禁止在原 ID 下覆盖已被引用的内容。
