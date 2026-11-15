# 临时 Agent Environment

## 资源与复用边界

1. 沿用 `AgentConfig → Environment → Instance → ACP Session`，不增加 Agent Service 或新的 Session 表。
2. 外部后端持有现有用户 API Key；每个独立访客交互创建 `temp-<UUID>` Environment 和一个非默认 `api/api` Instance，不创建访客账号或独立沙盒。临时环境不开放普通用户实例创建入口，避免额外实例绕过初始实例的来源确认与生命周期登记。
3. Environment 归调用方组织和用户；创建、续期、聊天均重新校验资源权限。普通环境选择、控制台及 ACP 发现列表排除临时环境。外部实例列表默认排除临时环境，可用 `environmentType=regular|temporary|all` 显式筛选；按 ID 查询与正常删除仍可用。
4. 工作区按原规则计算：`{WORKSPACE_ROOT}/{organizationId}/{userId}/{environmentId}`。文件接口、路径防越界和执行节点解析全部复用现有实现。

## 接口

以下路径前缀为 `/api/v1`；资源 API 使用原 `{success,data}` 响应，对话保留 OpenAI JSON/SSE。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/agents/:id/environments` | `{temporary:true}`；201 返回 `environmentId`、`instanceId`、`expiresAt`；只创建记录，不准备目录或启动 Runtime |
| POST | `/environments/:environmentId/renew` | `{}`；刷新期限并确保原 Instance 运行，返回原标识、期限及 `status:"running"` |
| GET | `/agents/:id/environment-policy` | 读取 TTL 覆盖、有效 TTL、系统上限及来源 |
| PUT | 同上 | `{ttlSeconds}`；需要 Agent update 权限，超过系统上限拒绝 |
| DELETE | 同上 | 删除覆盖；之后创建、续期恢复默认 TTL，不改已写期限 |

聊天继续使用 `/chat/completions`，通过 `X-Instance-Id` 指定临时实例。工作区、状态、停止、连接和重启复用原接口。

显式 `POST /instances/:id/stop` 返回 `202` 表示受理，后台继续严格停止；调用方查询实例直至 `stopped`，`unknown` 表示停止未确认。TTL 回收仍等待严格停止完成才写 `expiryReclaimedAt`，HTTP 受理不构成回收确认。

`environmentId` 定位文件与期限；`instanceId` 定位 Runtime；响应头 `X-Session-Id` 中的 `fcs_*` 是原 HTTP 续聊句柄，具有原来的 30 分钟空闲规则。同句柄并发仍返回 409，每次使用检查环境期限；renew 不延长句柄。Runtime 停止后旧句柄失效，可携带 messages 历史重新开始对话。

## 生命周期与并发

1. 创建与显式 renew 写入 `expiresAt = now + effectiveTTL`。默认 3600 秒，受 `RCS_TEMP_ENV_MAX_TTL_SECONDS` 限制（默认 86400 秒）；上限限制每次续期时长，允许重复续期。
2. 创建只写 Environment、Instance 记录；首次聊天或显式 connect/renew 沿原 `prepare → start` 准备目录、引擎配置及节点侧实例状态，再启动 Agent。文件接口沿原实例准备时机可用，不保证首次启动前上传。聊天、文件访问、心跳和运行活动均不自动续期。
3. 运行中的 Runtime 不强制刷新配置，批量配置重启跳过临时环境；实际停止后恢复读取当前 AgentConfig。共享 Machine／沙盒及其既有节点解析规则保持原样。
4. 原 idle/activity 回收继续生效，提前回收只停止 Runtime，不修改期限。期限内按原路径重新启动，或通过 renew 显式恢复同一 Instance。
5. 到期拒绝新聊天及 Runtime 启动，取消在途 Agent 请求并停止该环境的 Runtime，活动执行也不豁免；保留 Environment、Instance 和目录。状态、停止、删除及 renew 仍可用。
6. **文件访问不检查 expiresAt，不增加文件在途取消。** 文件仍按原身份授权和路径边界访问；远端实例尚未准备或已停止时，按原逻辑可能没有工作区映射，无法访问文件。renew 成功恢复原实例后重新登记映射，继续访问原目录。
7. 准入、续期和到期停止按环境串行；旧 timer 停止前重读期限。`expiryReclaimedAt` 为空表示本轮到期回收尚未确认，只有全部实例严格停止成功后才写入，确认写入失败也继续保留待办。创建为空；renew 在写入新期限时同时清空旧确认。该字段不表示实例的实时运行状态。
8. renew 先保存期限再启动；机器不可用、并发不足或启动失败时保留已写期限，允许重试。普通与临时实例共用现有用户并发算法，动态设置见[并发策略](./agent-concurrency-policy.md)。
9. 保留精确期限 timer；停止失败由数据库待办兜底。服务启动及每 10 分钟扫描已过期且未确认的临时环境，每批 100 条、按稳定 ID 游标翻页；单项失败不阻塞后续环境，成功历史退出扫描。停止确认更新同时匹配环境 ID 和捕获的期限，防止旧回收结果覆盖新一期续期。
10. 空内存与默认 `stopped` 不能证明历史 Runtime 退出。回收复用当前 Core 记录、当前控制面已观察实体的停止确认，或本控制面新建环境的事实；无法确认来源的历史项继续保留待办并记录日志。本功能不新增历史节点归属、跨进程 PID 接管或孤儿清理协议，持久待办保证不会因重启丢失，不扩大原有节点恢复的保证范围。

## 模块与数据所有权

| Owner | 职责 |
| --- | --- |
| agent-runtime | 临时环境 Facade、创建/续期、期限调度、Runtime 停止、聊天准入 |
| agent-config | `agent_environment_policy` 及其授权接口；启动参数关闭平台长期记忆 |
| machine | 复用原本地/远端文件路由与执行节点解析 |

数据库变更仅包含：

1. `environment.expiresAt`：可空通用时间戳，普通环境为空；普通环境唯一约束排除 `temp-*`，另加期限索引。
2. `agent_environment_policy`：`agentConfigId` 主键/外键、正数 `ttlSeconds`、创建/更新时间；随 AgentConfig 删除。AgentConfig 本身及 extra 不增加临时标记。
3. `environment.expiryReclaimedAt`：可空时间戳，记录本轮到期回收的确认；期限索引只包含未确认记录。已有临时记录初始为空，纳入启动补扫；普通环境不参与临时回收扫描。

不新增执行节点、运行状态、epoch 或服务会话字段。环境创建不访问 Machine 或沙盒；执行节点不可用不影响创建记录，后续启动按原流程报告失败。目录创建、登记和停止注销全部复用现有实现，不新增 acp-link 节点协议或节点侧临时环境特例。

## 记忆、重启与已知边界

1. 临时环境在 `buildMemoryLaunchEnv` 读取 Hindsight 配置、成员 bank 之前返回关闭结果，不注入平台记忆插件或配置文件。
2. SDK 与四个引擎插件保持原实现；本功能不重新隔离 HOME、临时目录、XDG 或引擎全局历史。动态 cwd 只提供原有工作区边界，共享沙盒不提供进程安全隔离。MCP 外部数据由工具自身权限控制。
3. 启动保留原 `expiresAt`，按剩余期限恢复尚未到期临时环境的到期任务，不自动续期；已过期未确认的环境进入持久补扫，仍拒绝新执行。原 HTTP/ACP 会话不保证跨服务重启恢复，期限内可通过原聊天或 connect 恢复 Instance。续期、远端 clean-slate 及本地进程恢复沿现有 Runtime 逻辑，不新增跨进程治理；无法定位的旧 Runtime 不误标为已回收。
4. 自动回收只停止 Runtime；正常删除 Environment 和 AgentConfig 仍按原流程删除关联记录。工作区、历史环境记录的周期清理另行处理，可根据 `temp-*` 路径识别。
5. 单活动控制面语义保持；不新增分布式计数、到期调度或取消协调。
6. 本功能面向外部 HTTP/SDK/ACP 入口，不新增临时控制台聊天或 Workflow 产品流程。
7. Claude 本地执行链既有问题见[后续记录](../design/claude-code-execution-chain-follow-up.md)，本功能不修复它，也不改变各引擎原有能力。

升级须先应用 Drizzle 迁移，再启动应用；回退应用时可保留新增列和策略表。排障可按 `temp-*` 环境 ID 查询期限、原 Instance 状态及到期停止失败日志。
