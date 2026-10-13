# 领域术语表（Domain Glossary）

> **来源**：`grill-with-docs` 面试输出（编排域 2026-08-03、Chat 域 2026-08-04、资源版本域 2026-08-11）。
> **定位**：跨域**词汇索引**——只钉住术语含义与「避免使用」的用词口径，机制细节以各域架构文档为准（每节给出对应篇目）。
> **迁移**：2026-09-24 由 `spec/global/CONTEXT.md` 迁入此处（原 `spec/` 整棵树不在目录结构规范内）。原文里过期的重构进度叙述、「当前目标架构」草稿与流程待办已删除；术语表逐条与当前实现核对过。

## 编排域

机制细节见 [`20-orchestration-management.md`](./20-orchestration-management.md)；关键决策见 [`docs/adr/2026-08-03-orchestration-package-design.md`](../adr/2026-08-03-orchestration-package-design.md)。

| 术语 | 定义 | DB 表 | 备注 |
|------|------|-------|------|
| **AgentConfig** | Agent 的配置蓝图，定义 Agent 是什么及能做什么 | `agent_config` | 编排域只读 |
| **Environment** | 资源管理层，调度 Instance 生命周期 | `environment` | agentConfigId 强绑定，非 agentConfigName |
| **Instance** | 纯运行时类，Agent 的运行载体 | 无 | N:1 绑定 AgentNode |
| **AgentNode** | 远端 Machine 在本侧的连接管理，持有 WS | 无 | 被动连接 |
| **AgentNodeService** | AgentNode 生命周期管理 | 无 | 引用计数 + 空闲超时 |
| **AgentController** | 编排域统一入口 | 无 | `spawnInstance()` 等 |
| **Machine** | 远端运行面，被 AgentNode 抽象化 | `agent_machine` | 编排域只读 |
| **Engine** | Agent 引擎类型（opencode / claude-code / ccb） | `agent_engine` | 编排域只读 |
| **Session** | ACP 会话 | `agent_session`（已废弃） | 下沉到 Agent 进程 |

## Chat 域

机制细节见 [`19-yjs-chat-streaming.md`](./19-yjs-chat-streaming.md)；关键决策见 [`docs/adr/2026-08-04-chat-channel-package-design.md`](../adr/2026-08-04-chat-channel-package-design.md)。

| 术语 | 定义 | 备注 |
|------|------|------|
| **rcsSessionId** | 前端 Agent 实例唯一标识（`rcs_*`，确定性生成） | 命名 Chat Doc / Session Doc / 广播通道 / 去重表 |
| **Turn** | 一次用户请求 → Agent 回复的完整执行单元（状态机：accepting → running → awaiting_permission → cancelling → 终态） | 终态不可逆；每会话单活动 turn |
| **Chat Doc** | `chat:{rcsSessionId}`，消息时间线投影（高频） | entries/blocks 结构 |
| **Session Doc** | `session:{rcsSessionId}`，会话元信息 / Agent 状态 / pendingPermissions（低频） | activeTurn、agent、pendingPermissions |
| **Yjs Gateway** | 前端 WebSocket 接入（认证、限流、协议解码、心跳、背压） | 连接级 |
| **SessionChannel** | 连接绑定至安全上下文与会话频道，路由 Action/Update | 协议层测试 seam |
| **CommandCoordinator** | Action 校验、commandId 幂等、命令串行化、turn 状态机驱动 | |
| **ACPChannel** | ACP 协议适配：命令转发、私有帧规范化为事件 | acp-link 私有帧 → 规范化事件 |
| **EventAggregator** | 规范化事件 → Y.Doc 有界聚合 | 只消费 session/update 语义 |
| **DocManager** | Y.Doc 镜像与 update 生成 | |
| **YjsBroadcaster** | 同 rcsSessionId 客户端 fan-out 与背压 | |
| **Action / Ack** | 前端命令信封（commandId）+ 两阶段确认（accepted/committed/duplicate） | 前端只发 commandId（UUID） |
| **commandId 去重表** | 防重复副作用：重复 Action 返回原 Ack，不重复调用 Agent | 进程内 Map，随实例生命周期 |
| **pendingPermissions** | Session Doc 中的待授权权限请求，CAS 解析（仅 pending→resolved 一次） | |
| **租约（lease）** | **不实现**：事件日志与租约 fencing 均不落地（YJS CRDT 已保证文档一致性），防重复副作用由 commandId 去重承担 | 原设计中的 `leaseEpoch` 字段已无类型占位，口径见 `packages/chat-channel/README.md` |

## 组织与权限域

| 术语 | 关联 |
|------|------|
| Organization | 多租户隔离边界 |
| User | 用户身份 |
| Team | 尚未实施，口径待定 |

## 资源版本域

> **权威设计文档不在本分支**：`docs/arch/07-versioning.md` 只存在于 `origin/feature/add-experts`（提交 `fae58d1e4`，2026-08-12，「docs: 确立资源版本控制权威设计」），本分支的代码里也没有对应实现。
> 本节因此**只保留术语与用词口径**，供命名与评审时对照；待该设计并入本分支后再复核一遍。原文写于引入这套词汇时，不随本条迁移改动。

| 术语 | 定义 | 避免使用 |
|------|------|----------|
| **资源（Resource）** | 可以连续保存多个版本的业务对象。 | 用某一版本代表整个资源 |
| **资源 ID（Resource ID）** | 一个版本链的稳定身份；同一资源的所有版本共享相同 ID。 | 版本 ID、物理版本行 ID |
| **MAX 工作版本（MAX Version）** | `version = Version.MAX` 的唯一可编辑工作版本；可以引用其他资源的 MAX 或确定整数版本。 | 独立 latest 指针、Draft 表 |
| **锁定版本（Locked Version）** | `1..Version.MAX-1` 范围内、当前资源数据不可修改的整数版本；其引用仍可指向目标 MAX。 | 完整依赖快照、Release |
| **版本键（Version Key）** | 唯一定位一份快照的 `resource_id + version`，也是资源引用的目标。 | 额外的 version UUID |
| **MAX 引用（MAX Reference）** | 来源工作版本对目标 MAX 的动态引用；目标编辑后，来源工作图读取新内容。 | 固定引用 |
| **确定版本引用（Exact Version Reference）** | 指向目标整数锁定版本、不会随时间变化的引用。 | MAX 引用 |
| **单资源锁定（Resource Lock）** | 把当前资源的 MAX 聚合复制为新整数版本、并原样保留全部引用值的动作。 | 递归锁定、依赖快照 |
| **锁定 Key（Lock Key）** | 调用方为一次锁定意图生成的幂等标识；同一资源链用相同 key 重试时返回第一次创建的版本。 | 版本 ID、资源 ID |
| **资源 DAG（Resource DAG）** | 资源类型只按架构声明的单向层级引用；允许共享下游，禁止反向、自引用和任意类型关系。 | 树、通用资源图 |
