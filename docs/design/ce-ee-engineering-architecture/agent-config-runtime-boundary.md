# AgentConfig 与 Agent runtime 边界

> 状态：ARC-03 输入草案。本文不属于 ARC-02 已冻结结果；它保留 AgentConfig 九类依赖能力、最小 starter、启动顺序、InstanceManager 责任、secret 与调用场景生命周期，等待 ARC-01、ARC-02、AGT-00 完成后由 ARC-03 最终确认。Package/module ID 只见[根索引](../ce-ee-engineering-architecture.md#4-identity-summary)。

## 1. 唯一依赖方向

```text
trusted caller
  -> AgentConfig actor-aware Facade
     -> authorize AgentConfig use
     -> actor-free resource services resolve stable references
     -> version/status recheck
  -> AgentConfig-local AgentInstanceStarter port
  -> apps/server adapter
  -> AgentInstanceManager
     -> quota / instance ID / registry / lifecycle / compensation
  -> AgentRuntime
  -> selected Engine provider
```

AgentConfig package 不导入 agent/runtime/plugin SDK 内部类型；agent packages 不导入任何 resource。Apps/server 同时依赖双方公开根入口，用 adapter 实现 resource-local starter port。该 port 与 agent-side executor 是不同类型，不互相 re-export，也不新增 capability；assembly 仍只有根索引列出的 instance starter slot。

Resource Facade 负责可信 actor、`use`、状态、引用与业务编排；actor-free resource services 解析已持久化的 stable ID。Runtime 不回读 AgentConfig、Environment、权限或其他资源表，不接收 actor/role/claims/transaction。Apps adapter 只转换已验证数据与注入依赖，不重新实现资源规则。

`AgentInstance` 是运行产物。Instance ID、配额、并发 admission、运行 registry、启动补偿、stop/reuse policy 和最终释放由 InstanceManager 拥有；EngineRuntime 只负责执行目标上的 prepare/start/stop 与 transport primitive。Relay 关闭不代表实例停止。

## 2. 九类逻辑依赖能力

下表只冻结 Domain Service 职责、首期边界和 owner，不强制九个物理 package，不猜方法名、DTO 字段、表结构或 resolver interface。Actor-facing 管理与选择统一遵守 [资源/API 边界](./resource-api-web-boundaries.md)；当前创建、查询、编辑、删除或运行真实会调用的能力必须在首期迁移，新 AgentConfig 不得反调旧 `src/services/**`。

| logical capability | actor-free Domain Service responsibility | AgentConfig first slice | deferred outside first slice | failure / secret boundary | owner task |
| --- | --- | --- | --- | --- | --- |
| Model | 按 stable ID 读取状态并提供最小 runtime model 值；封装 Provider 关系 | 可见选择的服务端重验、状态/协议/model/base URL 等运行解析 | 完整 catalog 的非闭环功能 | missing/disabled/incompatible 在副作用前失败；不返回明文凭证 | REF-01 |
| Provider | 解析 Provider 状态、credential reference、预算与运行所需结果，供 Model 边界消费 | AgentConfig 间接通过 Model 使用；预算/凭证拒绝可诊断 | 无真实调用的 provider 扩展 | credential 仅 server memory；unavailable/disabled/budget exceeded 明确失败 | REF-01 |
| Skill | 按 ID 批量解析 runtime file/archive descriptor，维护 metadata/file/archive 一致性 | 选择/绑定重验、归档生成或重建、下载描述、失败回滚 | 与 AgentConfig 无关的边缘页面/动作 | 路径/token/archive 不进 Web/日志；missing/build failure 阻止启动 | REF-02 |
| MCP | 按 ID 解析最小 launch values 并验证类型与配置 | 选择/绑定重验；URL/command/env/header/timeout 的运行转换 | Inspector 等无闭环证据能力 | OAuth/header/env 仅 server 解密；invalid/secret unavailable 失败 | REF-03 |
| Knowledge | 解析 binding、priority、enabled、policy 与运行 contribution | 可见选择、binding、引用计数/删除保护、knowledge MCP contribution | 完整 ingestion 管线 | Provider secret 不进 DTO；missing/disabled/resolver failure 明确 | REF-04 |
| Memory | 按持久化开关解析 Hindsight/default memory contribution | 保存并解析 Agent 所需 enabled/config；有独立用户动作才有 Facade/Web | 推测性的独立资源 UI | backend unavailable 时不能静默禁用；secret 仅 server | REF-04 |
| Environment | 提供执行快照、workspace identity、AgentConfig 关联与删除清理输入 | CRUD/start-stop 所需关联、运行环境和可枚举 cleanup | Chat/YJS/ACP 会话协议 | wrong owner/state/workspace/cleanup failed；Environment secret 不进审计 | ENV-01 |
| Node/Machine/Sandbox | Environment 解析 node；Sandbox 幂等准备后产出唯一 execution target | 节点/pool 选择重验、online/available/default-local policy、用户隔离 | Cluster control plane 等非闭环能力 | auth/tunnel/provider secret 受保护；remote failure 不回落本地 | ENV-01 |
| Site App | 按 stable ID 提供 binding/详情所需状态 | 管理/选择/binding/详情、引用删除规则 | build/deploy/version/proxy；首版不贡献 launch snapshot | missing/not visible/disabled；不把 Site secret 带入 launch | ENV-01 |

依赖方向是 AgentConfig → Model/Skill/MCP/Knowledge/Memory/Environment/Site App。Provider 由 Model 封装，Agent Node 由 Environment 封装，Sandbox 依赖 Agent Node且 Environment 不硬依赖 Sandbox；AgentConfig 不直接依赖这三者。被引用资源不得反向 import AgentConfig repository。

创建/编辑时 Facade 重验当前主体能否选择每个引用。运行时顶层 `use` 成功后，Domain Service 按持久化引用解析，不再次要求用户拥有底层资源独立 read；但资源缺失、禁用、版本冲突、不兼容、预算或凭证失败仍阻止启动。Site App 不进入首期 launch snapshot。

## 3. 最小 starter 候选

以下是供 ARC-03 评审的最小 runtime TypeScript 草案。它只表达 server-only、已授权且已解析的输入和 running 结果；不定义泛型聚合、深层只读工具、内部控制回调、时限载体、摘要、幂等 key、主体投影、reservation API 或补偿注册协议。具体 package、launch snapshot 字段与公开状态由 ARC-03/AGT-02 冻结。

```ts
export type ResolvedExecutionTarget =
  | Readonly<{ kind: "local" }>
  | Readonly<{ kind: "machine" | "sandbox"; targetId: string }>;

export type ResolvedAgentStartInput = Readonly<{
  agentConfigId: string;
  environmentId: string;
  source: "interactive" | "scheduled" | "system";
  correlationId: string;
  executionTarget: ResolvedExecutionTarget;
  launchSnapshot: Readonly<Record<string, unknown>>;
}>;

export type StartedAgentInstance = Readonly<{
  instanceId: string;
  state: "running";
}>;

export interface AgentInstanceStarter {
  start(input: ResolvedAgentStartInput): Promise<StartedAgentInstance>;
}
```

`ResolvedAgentStartInput` 由 AgentConfig 边界拥有。`agentConfigId` 与 `environmentId` 是已校验 stable ID；`source` 由受信任 use case 设置，外部 body 不得声明 scheduled/system；`correlationId` 只用于 trace/audit，不授权或充当幂等 key。`executionTarget` 必须恰好一个，不能同时传 local/machine/sandbox 多目标。`launchSnapshot` 是 AgentConfig 从各资源结果独立复制的 server-only snapshot，不是数据库行、resource service 或当前 plugin SDK 类型。

`start()` 是“以已解析输入启动并等待 running”的 resource-local primitive，不等于产品 `POST .../run`，也不承诺 Environment 复用、session、turn、relay URL、Workflow lease 或 Chat connection。其 adapter 将输入转换为 agent-side capability；两侧不共享内部类型。

## 4. 启动时序与 linearization

时序必须在任何实现形状下保持：

| order | stage | owner | invariant / failure behavior |
| --- | --- | --- | --- |
| 1 | authorize | AgentConfig Facade + AccessControl | 对当前可信主体校验 `use`；deny/context invalid/outage 在运行副作用前失败 |
| 2 | version/status recheck | AgentConfig + actor-free resource services | 条件重读 AgentConfig、Environment 与所有运行引用；确认 runnable、版本一致、唯一 target plan |
| 3 | quota admission | InstanceManager | 按可信主体/source/租户隔离获取 reservation；超限零 prepare/start 副作用 |
| 4 | side-effect prepare | resource owners + execution target adapter，受 InstanceManager 编排 | 解析最小 secret，准备 archive/workspace/Sandbox/node；每个副作用可补偿且不重复执行 |
| 5 | start | InstanceManager → AgentRuntime → Engine | 生成/登记 instance，传入已解析 snapshot，等待 running；runtime 不回读资源/权限 |
| 6 | compensate / release | InstanceManager 协调各 owner | 任一步失败逆序收敛副作用、释放 reservation/secret；补偿错误不覆盖 primary error |

授权与 version/status recheck 是 commit-to-start gate。Gate 前撤权或引用变化必须零运行副作用失败；gate 后是否停止已运行实例属于独立 revoke/operations policy，runtime 不持续查询权限。Quota 必须早于 archive、workspace、Sandbox、node 或进程副作用。

并发 start 对相同可信请求应由 InstanceManager 合并或判定冲突，只有一个 owner 执行 prepare/start；等待者取消不能错误终止仍有 owner 的共享启动。超时、重放 identity、跨进程 lease 与具体 join 机制由 AGT-01/02 设计并以 contract tests 证明，本草案不冻结算法或内部控制 surface。

Prepare 前后发现版本、target plan 或输入绑定不一致时，不调用 runtime，执行已产生副作用的补偿并返回 reference/start conflict。补偿使用独立有限 cleanup budget，不继承已取消的 caller signal；超时进入告警与 reconciliation。实现不得无边界重试、吞错或在失败后后台登记 running。

## 5. 数据分类与 secret 生命周期

| data class | producer | allowed consumers | prohibited destinations | release point |
| --- | --- | --- | --- | --- |
| stable identity/source | authenticated use case + resource owner | Facade、adapter、InstanceManager、runtime trace | 外部调用方伪造 source；用 correlation 授权 | operation terminal state |
| execution target | Environment/Node/Sandbox owner | adapter、InstanceManager、runtime | 多目标、浏览器 cwd、远程失败本地 fallback | stop/failed cleanup |
| resource launch values | Model/Skill/MCP/Knowledge/Memory/Environment | AgentConfig snapshot、adapter、runtime/engine | DB row共享、runtime 回读 resource | start/refresh owner定义的最短周期 |
| credentials/secrets | credential/environment/provider owner | 最小 server-side launch chain | API/Web/log/audit/cache/persistence/fixture | success handoff、failure/cancel/compensation terminal |
| trace metadata | observability/request context | all server boundaries by allowlist | claims、tokens、prompt/file、raw external response | retention policy |

每个具体 snapshot 字段在 AGT-02 标出 producer、consumer、redaction 和 release point。只持久化脱敏 metadata，不持久化解密 secret、MCP header/env/OAuth、Environment secret、完整 prompt/file 或 opaque授权值。运行链路日志只能包含安全 reference 与非敏感 version摘要。

Workspace/cwd 由服务端按已认证 Environment 计算；浏览器输入不可信。配置 remote target 且 transport/file backend 不可用时明确失败，不回落本地形成文件分裂。Sandbox prepare 必须保持 tenant/user 隔离和幂等收敛。

## 6. InstanceManager 与 Runtime 责任

### 6.1 Snapshot 一致性

AgentConfig 解析不是把各 service 的返回对象拼接后原样透传。
每个 resource owner 提供当前状态与最小运行贡献，AgentConfig 在自己的边界复制、校验并形成独立 snapshot。
Snapshot 必须对应同一次 version/status gate，不能混合先后两次读取的不同版本。

Prepare 可能产生 archive、workspace、Sandbox target 或短期 credential。
这些值只能在 quota admission 之后创建，并与当前启动 operation 绑定。
Runtime 接到输入后不得再次按 ID 读取“最新资源”来修补 snapshot，否则会破坏授权与版本 linearization。
Refresh 或 reuse 若需要新配置，是新的明确 use case，需要重新授权和解析，不能隐式修改正在运行实例。

### 6.2 责任矩阵

| concern | InstanceManager owns | AgentRuntime owns |
| --- | --- | --- |
| identity | 生成 instance ID，维护运行 registry | 消费 instance/target identity，不重新定义资源 ID |
| admission | 全局、主体、source 与环境级 quota/reservation | 不自行放宽配额 |
| concurrency | start 合并/冲突、operation 终态、reuse policy | 对单实例 primitive 保持幂等或明确失败 |
| lifecycle | running/stopping/stopped、stop/reuse、idle policy、registry 对账 | prepare/start/stop/relay transport primitive |
| failure | 主错误、逆序补偿、reservation/secret 释放、reconciliation | 返回保留诊断上下文的 engine/transport error，释放自身句柄 |
| resource access | 不解析 claims；只消费经过 resource gate 的输入 | 不读取 AccessControl 或任意 resource service/repository |

当前多层 LaunchSpec、Controller/Core/store/supplement 的状态碎片是提取输入，不是目标包必须复制的 public API。`get/list/refresh/connectRelay` 是否公开、跨进程 quota/lease/start lock、远端 stop 确认等由 AGT-01 按真实消费者收敛，不能从最小 `start` 推导。

提取期间必须保留可比较行为：

- instance ID 在所有 runtime/relay/registry owner 间一致；
- quota reservation 在成功和失败的最外层都释放；
- startup 合并不让并发 caller 重复 prepare；
- stop 对已停止或部分启动实例可幂等收敛；
- local/remote engine 的错误保留分类且不泄漏 secret；
- process shutdown、machine disconnect 与 idle cleanup 都经过明确 owner。

这些是 AGT-00 特征的迁移保护，不要求目标包复制现有全局 map 或类结构。

删除 AgentConfig 时必须先完整枚举关联 Environment/instance 并幂等收敛；收集不完整、状态不确定或依赖不可用则不删。实例已停而 DB 删除失败必须可重试；DB 与 access cleanup 同事务域原子，异构补偿失败进入 reconciliation。Exact cleanup port 由 ENV/AGT/RES owners 后续决定。

## 7. 三类调用生命周期

### 7.1 共同底座与不可混用的标识

三类入口都复用现有 Agent chat/relay translator 与 ACP session message flow。
不得恢复独立 transport 或在新 Facade 内复制 session/new、session/load、session/prompt。
Relay JSON-RPC 对原始与 envelope 包裹格式的兼容由现有权威实现保持。
Runtime/Instance 提取只改变 owner 与注入，不改变 ACP payload 解释。

必须区分：

- AgentConfig ID：资源配置 identity；
- Environment ID：workspace、执行环境与交互入口 identity；
- Instance ID：一次运行实体；
- ACP session ID：Agent 协议 session；
- RCS/YJS ID：Chat 文档与广播隔离；
- request/trace/correlation ID：诊断关联，不是资源或授权 identity。

这些值即使都表现为 string，也必须由各自 owner 校验和转换。
不能把 ACP `ses_*` 当 RCS session，不能把历史 Chat route 的 `agentId` 机械解释成 AgentConfig ID。

### 7.2 生命周期矩阵

三类入口复用同一底层 relay 与 ACP 消息规则，但 owner 不同：

| scenario | acquisition | turn/relay release | instance outcome |
| --- | --- | --- | --- |
| HTTP/OpenAI/Scheduler 单轮 | 每次独立创建实例并连接 relay | completion/error/timeout/cancel 均释放 turn 与 relay | 由单轮 owner 停止实例 |
| Workflow | `ensureRunning` 复用或创建，run 持 lease | 节点结束释放 listener/relay activity/lease | 复用实例保留；仅清理本 run 真正拥有且无 lease 的实例 |
| Interactive Chat | `ensureRunning`；按隔离键共享 relay，多标签页引用计数 | 最后客户端释放 channel/listener/relay；cancel 只收敛当前 turn | 实例继续运行，显式 stop/故障/回收路径负责终止 |

不能用一个模糊 `dispose()` 统一以上所有权。Relay close 只关闭连接；必须走 InstanceManager 生命周期才能证明进程停止。ACP session、RCS/YJS doc 与 instance ID 不得混用；详细当前事实继续以 AGT-00 map 和既有 Chat/Workflow 架构文档为准。

### 7.3 关键失败的收敛责任

| failure point | required convergence |
| --- | --- |
| authorize / reference validation | 不占 quota、不准备 target、不创建 instance |
| quota admission | 释放任何临时只读上下文；无 archive/workspace/Sandbox 副作用 |
| target/archive/workspace prepare | 逆序补偿已完成步骤，释放 reservation 与 secret lease |
| runtime prepare/start | Runtime 释放自身 handle；InstanceManager 清 registry/node/target 并执行上游补偿 |
| post-start registration | 停止已启动 runtime，再清 registry/reservation；返回原 primary error |
| relay/session acquisition | 释放已获 relay；是否停止 instance 由场景 owner 决定 |
| stop/remote disconnect | 继续可独立 cleanup，记录不确定状态并 reconciliation；不能仅删除本地记录宣称远端已停 |

Service shutdown 先停止新 admission，再收敛 active operation、relay/transport 和 instance，最后关闭 provider/DB/observability。
各层 cleanup 要幂等并保留 tenant/instance 隔离，不能因一个实例失败跳过其他可释放资源。
Process crash 会丢失 process-local coordination；AGT-01 必须明确启动后对账和 orphan diagnosis，即使跨进程锁后置。

## 8. 错误、观测与 contract tests

资源解析至少区分 not found/not runnable/reference invalid/reference conflict、credential unavailable、budget exceeded、execution target unavailable；实例层区分 quota、start conflict/cancel/deadline、engine prepare/start、transport 与 compensation incomplete。具体 code 字符串和 HTTP 映射由对应 owner task 冻结，但层级不能互相吞并。

审计关联两次授权/重验、quota、prepare/start outcome、instance ID、cleanup 与 reconciliation，只记录安全 reference/version摘要。Primary error 优先；cleanup/audit 次级错误单独记录。强制审计不可用时不得开始要求审计的启动副作用。

ARC-03/AGT-01/02 的 contract tests 必须覆盖：无授权与撤权零副作用、版本/status 冲突、quota before prepare、并发 join 单 owner、等待者 cancel/deadline、prepare 失败逆序补偿、runtime 失败释放、secret 生命周期、远程不回落本地、one-shot/Workflow/Chat owner差异。具体控制接口由实现 task 自己设计，不回写成 ARC-02 的公共协议。
