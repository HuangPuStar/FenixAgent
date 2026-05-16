# Feature: 20260514_F002 - plugin-opencode-runtime

## 需求背景

`plugin-sdk` 已经完成第一轮收口，当前仓库也已经有可工作的本地 `acp-link + opencode` 启停链路，但这些能力仍然散落在旧的 `src/services/instance.ts` 和 `src/transport/acp-relay-handler.ts` 中。

如果现在不先把 `plugin-opencode` 做成一个能独立跑通的 runtime 插件，后续 `core` 的生命周期接口虽然已经定义出来，实际却没有一个真实 engine 可以验证：

- `prepareEnvironment()` 是否足够承载 workspace 注入和配置物化
- `startInstance()` / `stopInstance()` 是否足够表达本地进程生命周期
- `connectRelay()` 是否足够承载 ACP 本地 WebSocket 通信

因此这一阶段不再扩展抽象层，而是以 `opencode` 作为第一个真实插件实现，优先打通“给本地 workspace 注入配置、启动/停止实例、通过 ACP 与实例通信”的最小闭环，并复用当前已经验证过的本地进程管理能力。

## 目标

- 让 `@mothership/opencode` 成为一个可实例化、可测试、可直接集成到新 runtime 流程中的 engine plugin。
- 复用现有本地 `acp-link` 进程管理经验，而不是重新发明一套进程控制逻辑。
- 对齐 `plugin-sdk` 当前四段式生命周期：`prepareEnvironment -> startInstance -> connectRelay -> stopInstance`。
- 在本地 workspace 中生成 `opencode` 可消费的配置与运行时文件，至少覆盖 agent、model、skills、mcp、env 注入。
- 通过 `connectRelay()` 暴露一个可用的 ACP relay handle，使上层能够与本地 `acp-link` 建立通信。

## 方案设计

### 一、范围边界

本 feature 只解决 `plugin-opencode` 本身跑通，不在这一轮内完成：

- `core` 的完整 registry / orchestrator 落地
- 远端 node / remote engine host
- 多 engine 共存调度
- 把旧的 `src/services/instance.ts` 全量删除

本 feature 完成后，预期结果是：

- `plugin-opencode` 包内部具备完整 runtime 实现
- 上层只要按 `plugin-sdk` 提供 `instanceId + launchSpec`，就能驱动一次本地 opencode runtime
- 旧服务层可以先通过适配方式调用该插件，作为后续迁移的过渡

### 二、推荐实现方式

推荐采用“插件内聚实现 + 旧逻辑抽取复用 + 上层薄适配”的方案。

#### 方案 A：推荐

把 `opencode` 私有逻辑集中到 `packages/plugin-opencode`，并从旧实现中抽取可复用能力：

- 端口分配与占用探测
- `acp-link` 子进程启动与停止
- stdout token 捕获
- relay WebSocket 连接与消息过滤
- `AgentLaunchSpec -> workspace runtime assets` 的物化，包括 `.opencode/opencode.json`、skills 解压目录和根目录 `.env`

优点：

- 最符合 F001 的边界设计
- 真实验证 `plugin-sdk` 是否足够
- 后续旧服务层切换成本最低

代价：

- 需要先定义少量插件内部状态管理对象
- 需要把旧实现拆成更细的可复用模块

#### 方案 B：不推荐

继续保留 `src/services/instance.ts` 为主实现，只在 `plugin-opencode` 里做一层很薄的转调包装。

优点：

- 改动最少，短期最快

缺点：

- 插件没有真正拥有 runtime 逻辑
- 后续迁移时仍要二次拆分
- 容易把旧服务层接口反向固化成插件接口

结论：

本 spec 采用方案 A，但允许第一阶段先从旧代码中拷贝或抽取稳定逻辑，再逐步回收旧调用点。

### 三、plugin-opencode 内部结构

`packages/plugin-opencode` 目标结构如下：

```text
packages/plugin-opencode/src/
  index.ts
  plugin.ts
  runtime/
    opencode-runtime.ts
    runtime-config.ts
    environment-preparer.ts
  process/
    acp-link-process-manager.ts
    port-allocator.ts
  relay/
    relay-handle.ts
  __tests__/
```

职责划分：

- `plugin.ts`
  - 导出 `createEnginePlugin()`
  - 组装 runtime 依赖
- `runtime/opencode-runtime.ts`
  - 实现 `EngineRuntime`
  - 串联 prepare/start/connect/stop 四段生命周期
- `runtime/runtime-config.ts`
  - 把 `AgentLaunchSpec` 翻译成 opencode 私有配置模型
- `runtime/environment-preparer.ts`
  - 负责准备 workspace 下的 `.opencode/` 运行目录
  - 负责写入 `.opencode/opencode.json`、workspace 根目录 `.env`
  - 负责衔接 skills 安装结果与本地运行时资源落位
- `runtime/skill-installer.ts`
  - 负责下载 skill 压缩包并解压到 opencode 可加载的位置
- `process/acp-link-process-manager.ts`
  - 负责本地 `acp-link` 进程启停、token 捕获和进程状态缓存
- `process/port-allocator.ts`
  - 负责本地端口分配与释放
- `relay/relay-handle.ts`
  - 负责把本地 WS 包装成 `EngineRelayHandle`

### 四、运行时生命周期设计

#### 4.1 prepareEnvironment

输入：`{ instanceId, launchSpec }`

职责：

- 校验 `launchSpec.workspace` 存在且可写
- 创建 workspace 下的 `.opencode/` 目录
- 将 `launchSpec` 翻译成 opencode 需要的配置结构
- 写入 `.opencode/opencode.json`
- 将 `launchSpec.env` 写入 workspace 根目录 `.env`
- 下载 `skills[]` 指向的压缩包并解压到 opencode 可识别的 skills 目录
- 缓存本次实例的运行准备结果，供后续 `startInstance()` 使用

约束：

- `prepareEnvironment()` 是唯一接收 `AgentLaunchSpec` 的阶段
- `startInstance()` 不再重新接收 agent/model/skills/mcp 等配置
- 若同一 `instanceId` 重复 prepare，默认覆盖之前的准备态

最小配置映射要求：

- `agent.name` / `agent.prompt`
- `model.provider` / `model.baseUrl` / `model.apiKey` / `model.model`
- `skills[]`
- `mcpServers[]`
- `env`

其中：

- `agent.name` 至少要能映射到 `default_agent` 或等价字段
- `mcpServers` 需要按 opencode 可识别的 transport 结构落盘
- `skills[]` 中的 `url` 指向 skill 压缩包，插件需要先下载再解压，不能只把 URL 写进 `opencode.json`
- skill 解压后的目录结构必须落到 opencode 当前可以扫描和加载的位置，路径选择要与现有 opencode 行为兼容
- `env` 不能只作为 `spawn` 时的进程环境变量传入；需要写入 workspace 根目录 `.env`，让 opencode 按现有读取方式生效

#### 4.2 startInstance

输入：`{ instanceId }`

职责：

- 读取 prepare 阶段缓存的 workspace 与启动参数
- 分配本地端口
- 启动 `acp-link --host ... --port ... opencode -- acp`
- 记录子进程句柄、pid、port、token、状态
- 在 stdout 中捕获本地 WS token

实现约束：

- 优先复用当前已验证的 `resolveExecutable("acp-link")`、端口探测和 token 捕获策略
- `cwd` 必须指向 `launchSpec.workspace`
- 不在这个阶段再写配置文件
- `startInstance()` 可以把 `.env` 合并进子进程环境，作为对 workspace 根目录 `.env` 的补充，但不能替代 `.env` 落盘

状态模型建议至少包含：

- `prepared`
- `starting`
- `running`
- `stopped`
- `error`

#### 4.3 connectRelay

输入：`{ instanceId, sessionId? }`

职责：

- 连接到本地 `acp-link` 暴露的 WebSocket
- 使用 start 阶段捕获的 token 完成鉴权
- 返回 `EngineRelayHandle`
- 过滤 `keep_alive`、`pong` 等不应透传给上层的噪音消息

设计要求：

- `connectRelay()` 不负责隐式启动实例；若实例未 `running`，应返回明确错误
- 一个 `instanceId` 同时只维护一个共享本地 WS 连接，避免重复创建多条底层连接
- 上层 relay 断开时，不应自动停止 `acp-link` 进程

#### 4.4 stopInstance

输入：`{ instanceId }`

职责：

- 关闭共享 relay 连接
- 向子进程发送 `SIGTERM`
- 必要时超时补 `SIGKILL`
- 释放端口和实例缓存

行为约束：

- `stopInstance()` 必须幂等
- 对不存在或已停止实例再次 stop，不应抛出不可恢复错误

### 五、插件内部状态与依赖

为保证 `startInstance()` 和 `connectRelay()` 不依赖外部状态，`plugin-opencode` 需要在 runtime 内维护一份最小实例状态表，例如：

```ts
type RuntimeInstanceState = {
  instanceId: string;
  workspace: string;
  launchSpec: AgentLaunchSpec;
  status: "prepared" | "starting" | "running" | "stopped" | "error";
  port?: number;
  pid?: number;
  token?: string;
  process?: ChildProcess;
  relay?: EngineRelayHandle;
  error?: string;
};
```

这份状态只用于插件内部运行时协作，不向 `plugin-sdk` 泄漏。

依赖注入建议：

- `resolveExecutable`
- `spawn`
- `WebSocket` 构造器
- `fs/path`
- 日志接口

这样测试时可以替换 spawn 和 WS，实现无真实子进程的单测。

### 六、与旧实现的迁移边界

可直接复用或抽取的既有能力：

- `src/services/instance.ts`
  - 端口分配与占用检测
  - `acp-link` 启停
  - stdout token 捕获
  - `cwd` 绑定 workspace
- `src/transport/acp-relay-handler.ts`
  - 本地 WS 连接模式
  - ping/pong / keep_alive 过滤经验

本轮不要继续放在旧服务层的能力：

- `.opencode/opencode.json` 写入逻辑
- workspace 根目录 `.env` 写入逻辑
- skill 压缩包下载与解压逻辑
- `opencode` 启动命令拼装细节
- relay 本地 token 的使用方式

过渡策略：

1. 先在 `plugin-opencode` 内复制并收敛实现，保证新包可独立测试
2. 再让旧服务层改为调用 `plugin-opencode` runtime，而不是继续内嵌 `opencode` 细节
3. 最后再评估删除旧 `instance.ts` 内与 `opencode` 强绑定的残余逻辑

### 七、测试设计

至少覆盖以下测试：

- `environment-preparer.test.ts`
  - 能在 workspace 下生成 `.opencode/opencode.json`
  - 能在 workspace 根目录生成 `.env`
  - 能准备 `.opencode/` 运行目录并落位运行时资源
  - mcp / agent / model 映射正确
- `skill-installer.test.ts`
  - 能从 skill URL 下载压缩包
  - 能解压到 opencode 可加载的目录
  - 重复 prepare 时能覆盖或更新旧 skill 内容
- `acp-link-process-manager.test.ts`
  - 启动后能记录 pid / port
  - 能从 stdout 捕获 token
  - stop 幂等
- `relay-handle.test.ts`
  - 能建立 WS relay
  - 能过滤 keep_alive / pong
  - close 后能清理状态
- `opencode-runtime.test.ts`
  - prepare -> start -> connectRelay -> stop 主流程可串通
  - 未 prepare 就 start 会报错
  - 未 running 就 connectRelay 会报错

## 实现要点

- 以 `plugin-sdk` 当前接口为准，不在本 feature 内再扩展新的生命周期方法。
- 先支持本地 runtime，不预埋 remote node 抽象分支，避免过度设计。
- `launchSpec.workspace` 是本插件的唯一 workspace 真相，不能再从 environment/session 侧兜底猜测。
- `skills` 的 `url` 是发布物入口，不是配置引用；prepare 阶段需要完成下载、解压和目录落位。
- `env` 的主生效路径是 workspace 根目录 `.env`，这样才能和 opencode 当前读取机制一致。
- 如果 opencode 配置格式与现有环境字段存在不一致，以“最小可运行映射”为准，不在本轮补齐所有历史兼容字段。
- 需要保留 token 捕获逻辑的注释，明确说明这是为了连接本地 `acp-link` WS，而不是复用 RCS secret。

## 验收标准

- [ ] `packages/plugin-opencode` 提供 `createEnginePlugin()`，并返回符合 `plugin-sdk` 的 `EnginePlugin`
- [ ] `prepareEnvironment()` 能在本地 workspace 写出 opencode 可消费的配置文件
- [ ] `prepareEnvironment()` 能把 `skills[].url` 下载并解压到 opencode 可加载的位置
- [ ] `prepareEnvironment()` 能把 `env` 写入 workspace 根目录 `.env` 并让 opencode 可读取
- [ ] `startInstance()` 能在 workspace 目录下启动本地 `acp-link opencode -- acp` 进程
- [ ] `startInstance()` 能记录并暴露后续 relay 所需的本地 WS token
- [ ] `connectRelay()` 能返回可用的 `EngineRelayHandle`，并与本地 acp 链路通信
- [ ] `stopInstance()` 能关闭 relay、终止进程并释放端口，重复调用不会异常
- [ ] 至少有一组 runtime 级测试覆盖 prepare/start/connect/stop 主流程
