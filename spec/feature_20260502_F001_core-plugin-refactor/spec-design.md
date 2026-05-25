# Feature: 20260502_F001 - core-plugin-refactor

## 需求背景

当前仓库已经同时承载了：

- Hono 后端路由与进程入口
- React 控制台
- `opencode` 相关实例启动、workspace 注入、relay 编排逻辑
- 通用配置能力（models、agents、skills、mcp）
- 通用控制能力（environment、session、workspace、task、scheduler、knowledge）

这套结构已经可以工作，但核心问题越来越明显：

- `src/index.ts`、`services/instance.ts`、`transport/*` 已经同时混合“通用编排逻辑”和“opencode 适配细节”
- 后续如果接入第二个 provider，现有代码很容易继续复制 `opencode` 的启动参数、配置注入方式和会话模型
- “知识库、记忆、skill、mcp” 这类扩展能力与 provider 适配能力目前没有稳定边界，后续只会继续耦合在 server 中
- 当前仓库是单体结构，重构如果直接大搬家，容易出现长时间双轨维护、review 困难、回归面过大

因此本 feature 的目标不是在现有代码中继续做大规模原位改造，而是新增一套平行独立工程，先把新的 `core + provider plugin` 骨架在隔离环境中搭起来，再按阶段接管旧系统能力。

## 目标

- 在当前仓库中新增一套平行独立工程骨架，明确新旧系统的隔离边界
- 定义最小可用的 provider plugin SDK，只覆盖当前已验证的 provider 适配需求
- 将当前 `opencode` 相关逻辑抽象为第一个 provider plugin，并保留现有行为兼容
- 将“通用控制能力”和“provider 私有行为”拆开，避免继续把 `opencode` 细节固化进 core
- 明确分阶段迁移策略，保证每个 spec 都小而可审查，避免一次性大规模漂移

## 方案设计

### 一、推荐总体方案

本次重构采用“仓库内新增平行独立工程 + 双轨并行 + provider SDK 最小化 + opencode 首个插件化”的方案。

推荐目录目标如下：

```text
mothership/
  apps/
    server/            # 新 Hono 入口、HTTP/WS 路由、依赖装配
    web/               # 新 React 控制台
  packages/
    core/              # 通用领域模型、编排服务、仓储接口、运行时协调器
    plugin-sdk/        # provider plugin 类型定义、能力声明、上下文对象
  plugins/
    opencode/          # opencode provider 适配实现

src/                   # 旧系统，迁移期继续保留
web/                   # 旧控制台，迁移期继续保留
```

说明：

- `mothership/` 是全新的目标工程，允许重新组织目录、脚本、依赖和测试结构
- 根目录现有 `src/`、`web/` 视为 legacy 系统，迁移期只做必要修复，不继续承接新架构演进
- 新工程与旧工程在一段时间内并行存在，但必须有明确的能力接管顺序
- `mothership/packages/core` 不直接依赖 `opencode`、`acp-link` 的启动命令格式或私有配置文件结构
- `mothership/plugins/opencode` 承接当前 `services/instance.ts`、`transport/acp-*` 中与 `opencode/acp-link` 强相关的行为

### 二、core 边界重定义

本次重构后，`core` 只保留所有 provider 都共享的稳定概念，不直接承载某个 provider 的私有运行细节。

#### 2.1 core 保留的能力

- `PluginRegistry`
- `EnvironmentService`
- `InstanceService`
- `SessionService`
- `WorkspaceService`
- `RelayOrchestrator`
- `TaskService`
- `SchedulerService`
- `KnowledgeBindingService` 或其他“provider 无关”的扩展关系管理

这些服务负责：

- 生命周期编排
- 状态读写
- 统一事件模型
- 统一错误模型
- 核心数据模型与仓储接口

#### 2.2 不直接放进 core 的内容

以下内容不应直接被定义为“运行时 core 服务”：

- `opencode.json` 的具体文件结构
- `acp-link --host ... opencode -- acp` 的启动命令拼装
- 本地 WS token 捕获规则
- provider 私有 keep_alive/握手差异
- provider 私有能力注入格式

这些行为都应该收敛到 provider plugin。

#### 2.3 控制面配置域的位置

`providers / models / agents / skills / mcp` 的配置管理仍保留为“平台配置域”，与 runtime core 平级；但这些配置一旦参与实例启动，就必须经过 core 的运行时解析层，再由 provider plugin 完成最终注入，不能直接由 `apps` 层拼装 provider 私有配置。

因此推荐结构为：

```text
mothership/apps/server/modules/config/   # 平台配置读写与管理 API
mothership/packages/core/                # 运行时编排 + 统一运行时配置解析
mothership/plugins/opencode/            # provider 私有配置注入
```

对应职责如下：

- 平台配置域：负责 `providers / models / agents / skills / mcp` 的存储、校验、CRUD 和引用关系
- core：负责把平台配置解析为统一运行时视图，例如 `AgentRuntimeSpec`
- provider plugin：负责把 `AgentRuntimeSpec` 翻译为 provider 私有配置并注入运行环境

建议在 core 中显式引入以下抽象：

```ts
interface AgentRuntimeSpec {
  providerId: string;
  model: ResolvedModelConfig | null;
  agent: ResolvedAgentConfig | null;
  skills: ResolvedSkillConfig[];
  mcpServers: ResolvedMcpServerConfig[];
  knowledgeBindings?: ResolvedKnowledgeBinding[];
}

interface RuntimeConfigResolver {
  resolve(input: ResolveRuntimeConfigInput): Promise<AgentRuntimeSpec>;
}
```

该模型只表达“本次运行需要什么配置”，不表达 provider 私有落盘格式。

### 三、provider plugin SDK 设计

本 feature 只定义 provider-plugin，不定义 abilities-plugin。

#### 3.1 插件元信息

```ts
export interface ProviderPluginMeta {
  id: string;
  displayName: string;
  version: string;
  capabilities: {
    multiInstance: boolean;       // 是否支持同一 environment 多实例
  };
}
```

#### 3.2 插件主接口

```ts
export interface ProviderPlugin {
  meta: ProviderPluginMeta;

  createRuntime(ctx: ProviderRuntimeContext): ProviderRuntime;
}

export interface ProviderRuntime {
  prepareEnvironment(input: PrepareEnvironmentInput): Promise<PreparedEnvironment>;
  injectRuntimeConfig?(input: InjectRuntimeConfigInput): Promise<void>;
  startInstance(input: StartInstanceInput): Promise<StartedInstance>;
  stopInstance(input: StopInstanceInput): Promise<void>;
  connectRelay(input: ConnectRelayInput): Promise<ProviderRelayHandle>;
  listSessions?(input: ListProviderSessionsInput): Promise<ProviderSessionSummary[]>;
  getHealth?(input: ProviderHealthCheckInput): Promise<ProviderHealthStatus>;
}
```

设计原则：

- core 只依赖接口，不依赖具体 provider 包
- provider 不直接操作 Hono context、数据库连接或前端类型，而是通过 `ProviderRuntimeContext` 获取受控能力

#### 3.3 ProviderRuntimeContext

`ProviderRuntimeContext` 由 core 提供，用于向 provider plugin 暴露受控宿主能力。建议结构如下：

```ts
interface ProviderRuntimeContext {
  logger: Logger;                      // 统一日志出口
  eventBus: RuntimeEventBus;          // 运行时事件发布/订阅

  environments: EnvironmentRepository; // environment 查询、状态更新
  instances: InstanceRepository;       // instance 登记、状态更新、metadata 持久化
  sessions: SessionRepository;         // session 创建、查询、providerSessionId 映射

  workspaceResolver: WorkspaceResolver; // 解析真实 workspace、临时目录、注入目录
  secretResolver: SecretResolver;       // 解析 provider secret、token、环境变量引用

  clock: Clock;                         // 提供统一当前时间，便于测试
  idGenerator: IdGenerator;             // 生成 instanceId、relayId、临时资源 id
}
```

不要把：

- 原始 `db`
- 原始 `Hono Context`
- 任意路径文件系统权限

直接暴露给插件，否则插件会反向绑死宿主实现。

### 四、核心领域模型

为避免当前 `environment / session / instance` 在内存、SQLite、transport 之间分散定义，重构时需要先统一核心模型。

#### 4.1 Environment

表示用户定义的“可启动 provider 运行单元”，包含：

- provider 类型
- workspace 指向
- 默认 agent / model 等平台配置引用
- provider 所需的连接密钥或 providerConfigRef

#### 4.2 Instance

表示某次 provider runtime 启动出来的运行实体，包含：

- `instanceId`
- `environmentId`
- `providerInstanceId`（可选，plugin 内部标识）
- `status`
- `startedAt`
- `runtimeMetadata`

其中 `runtimeMetadata` 是 provider 扩展字段，统一存 `json`，core 不解析私有结构。

#### 4.3 Session

统一表示用户交互会话，不直接等同于 provider 原生 session id。

需要明确区分：

- `sessionId`：RCS/core 自己的稳定主键
- `providerSessionId`：provider 返回的原生会话标识

这个区分非常关键，否则之后还会重复出现当前 ACP session ID 与 RCS session ID 混用的问题。

### 五、运行时编排设计

#### 5.1 Server Composition Layer

`mothership/apps/server` 在启动时负责：

1. 初始化 core services
2. 加载 provider plugins
3. 注册 `PluginRegistry`
4. 将路由请求转给 core facade

server 只保留：

- HTTP/WS 路由
- auth middleware
- request/response 映射
- 静态资源服务

server 不再直接拼 provider 启动命令，也不直接管理 provider 特有 ws 生命周期。

#### 5.2 RelayOrchestrator

`RelayOrchestrator` 由 core 持有，负责统一管理：

- 前端 relay 入口
- session 到 instance 的路由
- provider relay handle 生命周期
- 消息方向归一化

但真正的 provider 本地连接细节由插件实现。例如：

- `opencode` 需要连本地 `acp-link`
- 某些 provider 未来可能直接连远端 ws

core 只消费统一的 `ProviderRelayHandle`。

#### 5.3 Workspace 注入

workspace 注入保留为 provider 可选实现，不默认属于 core。这里的“workspace 注入”包含两类内容：

- 配置注入：例如生成运行时 `opencode.json`、instructions、agent 选择等配置材料
- 文件资源注入：例如 skills、MCP 相关文件、provider 只接受文件路径的资源

是否写入项目真实 workspace、实例临时 workspace，或 workspace 下的临时目录，由 provider plugin 自行决定；core 只关心“该 provider 是否需要通过 workspace 物化运行时材料”。

实例启动时的配置装配链路固定为：

1. `apps/server` 读取 environment 与平台配置引用
2. `core` 通过 `RuntimeConfigResolver` 解析出 `AgentRuntimeSpec`
3. `provider plugin` 将 `AgentRuntimeSpec` 和相关文件资源注入 workspace，并完成 provider 启动前准备

例如当前 `opencode` 的 `.opencode/opencode.json` 写入逻辑，本质是 provider 专属行为，应由 `plugins/opencode` 实现；core 只提供：

- workspace 路径解析
- 统一运行时配置视图
- 扩展绑定读取接口

### 六、opencode 插件化范围

`plugins/opencode` 第一阶段需要承接的内容包括：

- `acp-link` 子进程启动与终止
- 本地端口分配与探测
- 本地 WS token 捕获
- `opencode.json` 注入
- ACP relay 建立
- provider session 查询适配
- keep_alive / identify / register 等 provider 私有协议处理

但以下内容仍应保留在 core 或平台层：

- environment CRUD
- session 元数据
- 任务调度
- 用户认证
- 知识库绑定关系
- 前端 API 协议

### 七、双轨迁移策略

本次重构采用“旧系统冻结维护 + 新工程独立建设 + 最终切换”的策略。旧系统功能已基本完成，后续仅接收 bugfix；新架构、新能力和后续演进全部进入 `mothership/`。

#### Phase 1：新工程建骨架

- 建立 `mothership/` 独立工程目录
- 建立新工程自己的 `package.json`、`tsconfig`、构建脚本、测试入口
- 建立 `packages/core`、`packages/plugin-sdk`、`plugins/opencode`
- 先不接管线上能力，目标是让新工程可独立启动、独立测试

#### Phase 2：在新工程中完成 provider 适配层

- 先迁移 `instance` 启停相关逻辑
- 再迁移 relay / transport 中的 provider 私有逻辑
- `opencode` 成为唯一一个真实 provider plugin

#### Phase 3：新 server 接管核心链路

- `mothership/apps/server` 依赖 core facade
- 新 server 补齐 environment / instance / session / relay 主链路
- 新前后端达到可独立运行和验收的状态

#### Phase 4：完成切换与收尾

- 旧系统继续仅接收必要 bugfix，直到切换完成
- 前端和后端默认只在新工程继续演进
- 完成剩余 API / UI / 测试迁移
- 补 provider plugin 开发文档

#### 双轨并行的硬约束

- 新功能默认只进入 `mothership/`，除非是为了兼容旧系统运营必须补到旧代码
- 旧系统只接受 bugfix，不接受新的架构性增强
- 两边若共享配置文件或数据库，必须先定义兼容策略，禁止隐式共用

#### 每个子 spec 的约束

- 单个 spec 尽量控制在可 review 的范围内
- 单个 spec 优先只解决一个边界问题
- 每次迁移都必须保证旧 API 行为兼容，除非设计文档明确声明破坏性变更

### 八、不做的事情

本 feature 明确不做：

- 不定义完整 abilities-plugin SDK
- 不一次性迁移所有服务到 `packages/core`
- 不在本阶段同时支持多个真实 provider
- 不重写前端交互逻辑
- 不主动变更现有 `/web/*`、`/acp/*`、`/v1/*` 对外协议

## 实现要点

1. **新工程必须真正独立**  
   `mothership/` 需要有自己的脚本、依赖入口、测试入口和启动方式，不能只是把旧目录换个位置拷过去。

2. **先抽象、后搬运**  
   任何迁移都必须先定义 core 接口，再把旧代码塞进 adapter；禁止先复制文件再事后抽象。

3. **禁止把 opencode 私有格式升格为平台标准**  
   例如 `opencode.json`、本地 token 解析、命令参数拼装只能存在于 `plugins/opencode`。

4. **统一 ID 模型**  
   `environmentId`、`instanceId`、`sessionId`、`providerSessionId` 必须在类型层面显式区分，避免旧问题复发。

5. **核心状态归属先行**  
   在开始迁移前，需要先明确 `Environment / Instance / Session` 哪些字段由 core 持有，哪些字段走 provider metadata。

6. **测试按边界迁移**  
   优先补 `core` 契约测试和 `opencode plugin` 适配测试，再迁移路由测试；否则很容易出现只有端到端能跑、边界却失控的情况。

7. **双轨期间必须定义冻结线**  
   否则新旧系统会同时演进，最终不是“没有历史包袱”，而是“历史包袱 + 新包袱”并存。

## 约束一致性

当前仓库中不存在 `spec/global/constraints.md` 与 `spec/global/architecture.md`，因此本节仅说明与现有仓库约束的一致性：

- 保持“后端负责控制面与编排，前端消费统一 API”的总体方向不变
- 保持 ACP / relay / session 主链路在迁移期内稳定
- 保持前端修改后仍通过构建产物提供静态资源的部署方式
- 保持功能拆分为多个小 spec、小任务实施，避免一次性大改
- 允许通过平行独立工程承载新架构，以换取与旧系统的物理隔离

本方案现在与当前草案保持一致：**在仓库根下新增 `mothership/` 平行独立工程，采用双轨并行策略推进重构**。需要额外承担双份维护成本，但换来的是对旧结构的强隔离。

## 验收标准

- [ ] 仓库形成明确的 `mothership/apps`、`mothership/packages`、`mothership/plugins` 结构，并与旧系统物理隔离
- [ ] `core` 与 `plugin-sdk` 的职责边界在代码和文档中清晰可见
- [ ] 存在最小可用的 provider plugin 接口定义，可支撑 `opencode` 插件实现
- [ ] `opencode` 私有逻辑有明确迁移归属，不再继续向 core 扩散
- [ ] 设计文档明确区分运行时 core、平台配置域、provider plugin 三层
- [ ] 设计文档明确双轨并行期间的新旧系统边界、冻结策略和切换条件
- [ ] 后续实施 spec 可以按“新工程建骨架 → provider 迁移 → 新 server 接管 → 冻结旧系统”顺序拆解
