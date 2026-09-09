# 数据、可观测性与交付

> 本文是 schema/`./db`、CE/EE migration 顺序、data migration、存储替换、日志/审计/metrics/trace、部署发布回滚与 submodule 升级的 canonical detail。Package identity 见[根索引](../ce-ee-engineering-architecture.md#4-identity-summary)。

## 1. Schema ownership 与 `./db`

关系型主存储默认 PostgreSQL + Drizzle。表、索引和字段语义只由所属 module 的 `db` 面维护；根 Drizzle config 是工具输入清单，不定义或 re-export table。每个拥有 resource schema 的 package 必须提供 server-only `./db` export，并与根 server surface、可选 `./web` 隔离。

```text
packages/resources/<resource>/db/
├── schema.*                 # module-owned schema truth
├── data-migrations/         # module-owned business transforms
└── index.*                  # ./db public server-only boundary

drizzle.config.*             # 只枚举当前仓库 owner schema
db/migrations/               # 当前仓库生成的不可变 DDL + metadata chain
db/data-migration-runner.*   # 汇总、排序、journal、执行与观测
```

源码移动不是 DDL 变更。把历史 schema 定义移到 package 时必须生成并审查 diff，确认没有重复建表、删表或意外约束变化。Schema 真相切换与应用读写切换是两个可验证步骤，不能靠手工 SQL 绕过 Drizzle chain。

EE 的 generator 只列 EE 自有 schema。EE table 可从固定 CE package 的公开 `./db` 引用外键目标，但不 re-export CE table，也不把 CE schema 文件加入 EE generator input。EE 不用 migration 改 CE-owned table；通用变更先在 CE 发布，EE 专属字段/状态使用 EE 扩展表和 stable CE resource ID 关联。

CE 的权限 Context 由各受控资源主表的 `resource_context JSONB` 承载，并由平台 `ResourceContextStore` 统一读写、校验和迁移；AccessControl package 当前不拥有独立授权表。资源 package 不得导入或解析其他资源的 Context。Knowledge/Memory/Site/Environment binding 的物理 owner仍由数据设计 artifact 决定，逻辑 owner 与依赖方向不因此改变。

## 2. CE/EE DDL migration

CE 与 EE 各自维护不可变 migration chain 和独立 journal，避免两个仓库争用记录。部署顺序固定为：

```text
backup + preflight
  -> CE DDL migrations
  -> EE DDL migrations
  -> ordered data migrations
  -> application deployment
  -> readiness / critical-path probe
  -> traffic switch
```

EE 对 CE table 的依赖以 submodule 固定 commit 为准；CE migration 必须先保证外键目标存在。每个 schema change：

1. 修改 module-owned schema 与 contribution；
2. 通过仓库标准 generate command 生成 DDL 与 metadata；
3. 审查 SQL、snapshot、journal、锁范围与已有数据影响；
4. 对空库和从受支持版本升级的数据库执行 migration smoke；
5. 发布前备份、检查 DB 连通性、版本和 migration 状态；
6. 已发布 migration 不改写，修复以新的补偿 migration 追加。

生产演进采用 expand → backfill → switch → observe → contract。删除列、收紧约束或改变解释前，当前与前一应用版本必须在声明的兼容窗口内共同读取扩展 schema。Contract 后只能回滚到仍兼容当前 schema 的镜像，否则先执行批准的补偿路径。

多实例部署不能让每个 app 启动时自行竞争执行业务 migration。DDL 与 data migration 是发布任务；journal、锁与幂等保证由 runner 负责，失败停止后由 operator 依据进度和补偿继续。

## 3. Data migration

### 3.1 Runner 与 module contribution

数据转换依赖领域历史状态，代码与验证就近归资源 module；仓库 runner 只做静态汇总、依赖排序、批次、journal、日志/指标、失败停止与结果记录，不承载业务逻辑。

每个 data migration 必须有全局唯一稳定 ID，并声明或记录：

- 所依赖的 DDL/data migration；
- 可重试、幂等且有边界的 batch 行为；
- 完成验证、记录数/ID set/关键业务投影的校验；
- 数据规模、锁/IO 风险、timeout/backpressure；
- 安全的进度与错误观测；
- 失败、部分完成和版本回滚时的补偿/继续条件。

跨 module migration 归发起语义变更的 owner，并显式依赖其他 migration。它使用受限的 repository/SQL adapter，不调用当前运行中的 Domain Service，因为该 service 可能已经按新数据语义工作。不得为迁移构造 actor 或绕过租户规则读取不相关数据；维护路径应有独立授权、审计和最小权限。

Stable ID、`resource_context`、binding 与历史 name 引用的回填必须可审计。切换前比较记录数、ID 集合、关键 list 结果、orphan 与冲突；异常时停止，不用默认值静默吞掉。完整垂直迁移规则见 [迁移、治理与测试](./migration-governance-testing.md)。

### 3.2 Batch、重试与恢复

Runner 在开始 batch 前记录 migration ID、owner module、source/target version 与安全的进度位置。
同一 migration 的并发 executor 必须由 journal/lock 排除，不能依赖“通常只有一个 pod”。
Batch 大小、事务 timeout 和 backpressure 有配置上限；失败后从已提交 checkpoint 继续，不重做不可幂等副作用。

Migration 验证与主转换分离。
转换结束但 verify 失败时仍保持未完成状态，不允许后续依赖项运行。
Operator 必须能区分未开始、运行中、部分提交、待验证、完成和待补偿；不能用一条 boolean 掩盖部分状态。

补偿不是盲目反向运行。
每个 owner 说明哪些变化可逆、哪些只能前向修复、应用回滚到哪个版本仍安全。
补偿失败保留原 migration error，并单独告警；不得删除 journal 伪装未执行。

### 3.3 数据安全与租户隔离

Migration 可以使用受限维护 identity 访问跨租户数据，但必须按任务授权、审计和最小权限执行。
日志只记录 batch、计数、stable non-sensitive references 和 error code，不输出整行、credential 或 customer content。
历史异常数据进入明确 quarantine/report，不自动归到默认 tenant 或首个组织。
回填 `resource_context` 时，任何无法唯一映射的记录都应阻塞 switch 并由数据 owner 决策。

## 4. 更换存储

先区分领域存储与关系型主库：

| scenario | boundary | required proof |
| --- | --- | --- |
| Skill/archive/file/attachment/log/vector store 等领域存储替换 | 所属 resource/provider port 增加真实 adapter；关系型 metadata 保持 owner | contract tests、data copy/verification、failure fallback 与 rollback |
| PostgreSQL 主库替换 | 为所有 repository port、transaction、constraint compiler 提供新 adapter | constraint/index/transaction 等价、全量 migration、双环境核对、backup/rollback |

“支持多 DB”不能通过 domain/service 中的 database type 条件实现，也不能在没有第二真实实现时抽象全部 Drizzle 细节。新主库必须正确实现 AccessControl 授权查询下推，并通过相同 repository/tenant/concurrency contract suite。切换时只有一个权威写路径；未经设计的双写会制造不可判定的数据分叉。

## 5. Observability boundaries

Observability 提供 actor-free ingestion ports：

| port | purpose | distinct concern |
| --- | --- | --- |
| Logger | 结构化运行诊断、状态转换、依赖故障 | 不是不可抵赖审计 |
| AuditRecorder | 主体对资源/权限/运行/迁移的安全与业务审计 | 有独立 retention/access policy |
| Metrics | count、latency、quota、queue、resource usage、reconciliation | 不承载高基数 secret/raw payload |
| Tracer | HTTP、task、resource resolution、instance、provider 的因果链 | correlation 不等于授权或幂等 identity |

Observability 不依赖或回调 AccessControl。AccessControl 可以写 ingestion ports；需要授权的日志查询/诊断 route 位于更高层，同时依赖 AccessControl 与受控 projection。因此 bootstrap 先建立 observability，再装配 AccessControl。

Route 建立 request/trace context；异步任务、queue、instance、relay 与 provider 调用显式传播。Service 记录关键领域状态，adapter 记录 retry/timeout/外部故障，不在每层重复同一 error。默认运行日志输出 JSON stdout；文件归档、审计存储、日志平台、metrics/trace exporter 都是部署期 adapter。

## 6. Redaction 与强制审计

统一 allowlist 只包含 event/time/module/operation/result/error code，以及经过安全转换的 actor/tenant/resource/trace/correlation/instance reference 和非敏感 version digest。禁止记录：

- token、Cookie、密码、连接串、Provider/MCP/Environment secret；
- 完整 actor claims、memberships、opaque constraint 或原始 `resource_context`；
- request header/env、URL query、完整 launch snapshot；
- prompt、文件内容、Skill archive 内容、外部原始响应；
- 未经 owner 审查的路径、command 或内部 config。

审计至少覆盖 context invalid、AccessControl outage/deny、resource Context initialize/remove、AgentConfig CRUD/use、启动授权与 version gate、starter outcome、cleanup/compensation/reconciliation、super-admin 规则、migration 与发布。

Deny 是主结果：AuditRecorder 写失败不能把 deny 变成 allow，也不能覆盖 deny；另写受控 emergency diagnostic。Context initialize/remove、资源 mutation、start 和 migration 等要求强制审计的副作用，在 recorder 无法接受事件时不得开始或提交，返回独立 audit-unavailable 语义。Logger/Metrics/Tracer exporter 故障不伪装 deny；补偿或审计次级错误不覆盖 primary error。

PLT-03 定义具体 audit transport/schema、emergency channel、retention 和默认 adapter；PLT-04 负责统一 env loader。ARC-02 只冻结分层、字段分类与失败行为，不创建事件 schema。

## 7. Build、deploy 与 release

`scripts/` 是薄编排入口：

| workflow | responsibility |
| --- | --- |
| boundary check | 禁止依赖、公开 exports、browser surface、submodule clean |
| release build | server/Web 构建、registry generation、版本与 SBOM |
| CE/EE migration | 各自 DDL chain 与独立 journal |
| data migration | 按 manifest 依赖执行并验证 |
| deploy preflight | env、assembly、DB/migration、目录、镜像、外部依赖 |
| release | backup、migration、deploy、readiness、traffic、rollback decision |

`deploy/compose` 使用基础编排加受控 profile/overlay；数据库、模型网关、知识库、Sandbox 等可独立启停。模块声明依赖服务与健康条件，部署层选择或生成 profile，业务代码不启动 Docker/Kubernetes。

发布前验证 assembly candidate、env 冲突、migration 状态、外部依赖、磁盘与凭证可用性。发布后以 readiness 与 AgentConfig 关键链路探测再切流量。应用回滚和数据库补偿分开决策；任何失败保留 revision、migration batch、module/operation 与安全 correlation 上下文。

## 8. EE submodule upgrade

### 8.1 Release gate 与 rollout

Release artifact 必须把 server image、Web assets、registry、assembly profile、CE/EE revisions 和 migration versions 作为一个可追踪组合。
不能只回滚其中一个而忽略其余兼容范围。

Preflight 通过不等于业务 ready。
新版本在接收流量前至少探测 DB schema/journal、required providers、AccessControl、AgentConfig read/use、runtime start/stop 与 Web asset version。
探测只使用隔离的受控 fixture，不使用客户 secret 或写入未标记生产资源。

Rollout 期间比较旧/新版本的错误率、授权 deny/outage、list count/pagination、migration mismatch、start/cleanup 与 latency。
指标偏离阈值时停止扩流；如果 schema 仍兼容则回滚 app/profile，否则执行预先批准的前向补偿。
不得在故障时临时启用旧写路径或双写。

### 8.2 EE upgrade steps

1. 显式 checkout 经审查的 CE tag/commit，禁止无审查 `--remote`；
2. 审查 CE public exports、assembly、DB/env/deploy breaking changes；
3. 重新生成 EE server/Web registry，并验证 submodule 工作树无补丁；
4. 运行 EE type/boundary、CE→EE migration upgrade、最小启动与关键 E2E；
5. EE 适配只写 EE 自有 module；不修改 submodule；
6. 发布物记录 CE commit、EE commit、registry 与 migration versions。

不兼容时停止升级，或先在 CE 提供正式通用扩展点。紧急回退优先使用上一个已验证的 CE pointer + EE image；数据库仍按 expand/contract compatibility 判断。CI 必须证明 submodule 除合法指针外无源码差异。

## 9. 验收与回滚信号

数据/交付变更至少可观测 migration batch/progress/failure、backfill mismatch/orphan、request/operation result、authorization deny/outage、quota/start/stop、compensation incomplete、module health 和 readiness。指标标签必须有界，不把用户输入或 secret 当 label。

停止条件包括：migration 非幂等、锁或数据量超预算；空库/升级库结果不一致；旧/新写路径并存；权限查询结果变化无法解释；redaction 失败；submodule 有补丁；新镜像与当前 schema 不兼容。回滚回到最后一个已验证 app/assembly revision，保留扩展 schema 与 journal；若已进入不可逆 contract，必须走新的补偿 migration 而非改写历史。

## 10. 运行期诊断与保留

Log、audit、metric 与 trace 各自有访问控制、保留周期和删除策略。
控制台日志页只读取经过授权和脱敏的 projection，不能直接暴露容器文件、audit store 或 exporter payload。
系统管理员查询也保留真实 actor 与 tenant target，不能使用无主体后门。

高基数 resource/instance reference 只在 trace/log 中按采样与 retention 管理；metric label 使用有界 operation/result/code/module 维度。
Audit 需要可证明完整性与查询隔离，但不把 secret 或完整 claims 写入不可变记录。
数据主体删除与安全审计保留冲突由独立合规 policy 处理，不由 resource repository 擅自清 audit。

诊断流程应能从 request/trace correlation 定位到 module operation、授权分类、resource version、instance outcome 和 compensation state。
Correlation 只能用于查找，不能被重放成认证、授权或 idempotency proof。
Exporter outage、采样和 redaction 失败都要有自身 health signal；不能仅依赖同一失败 exporter 报告自己。
