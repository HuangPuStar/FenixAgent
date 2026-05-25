1. 借鉴来源
	1. Argo Workflows（K8s 原生 DAG、YAML 声明式、CRD 持久化）
	2. Temporal（Event Sourcing 持久执行、事件溯源恢复）
	3. Dagger（内容寻址缓存、多语言 SDK、OpenTelemetry）
	4. Dify（AI 工作流、Agent Function Calling/ReAct、可视化画布）
	5. n8n（可视化 + TypeScript、400+ 集成、AI-native）
	6. Apache Airflow（Python DAG、XCom 数据传递、Jinja 模板）
2. 核心理念
	1. 文件夹即项目——用户产出物（YAML、脚本、配置）全部是纯文件，可 git 版本控制
	2. 运行时数据（事件流、状态、节点输出）通过数据库持久化，MVP 阶段直接同步写入，MQ 接口预留
	3. 永远向后兼容：新功能只加可选字段，不修改已有字段语义
3. 执行原语抽象
	1. 三种执行原语，所有节点类型基于这三种实现
	2. ProcessExecutable（本地进程）
		1. 适用节点：ShellNode
		2. 生命周期：spawn → stdout/stderr → exit(code)
		3. 终止方式：SIGTERM → grace period → SIGKILL
		4. PID 记录在 node.started 事件的 metadata 中，用于恢复时检测残留进程
	3. RemoteExecutable（远程调用）
		1. 适用节点：AgentNode、API Node
		2. 生命周期：connect → request → stream response → close
		3. 终止方式：发送 cancel 消息（ACP 协议）
		4. 传输层通过 Transport 接口抽象，默认实现为 ACP 协议 stdio/WS 桥接
		5. 上层抽象使得可以自定义与 Agent 的交互方式，报错统一处理
	4. AwaitableExecutable（等待外部事件）
		1. 适用节点：审批节点
		2. 生命周期：register → wait → callback/timeout
		3. 终止方式：标记过期（token 失效）
4. 节点定义
	1. 统一输出格式（所有节点共享）
		1. { stdout: string, json?: any, exit_code: number }
		2. AgentNode：exit_code 固定为 0（连接失败时为 1），stdout 为 Agent 响应文本
		3. 审批节点：stdout 为审批数据 JSON，exit_code 为 0
		4. SubWorkflowNode：stdout 为子流程最终节点输出，exit_code 反映子流程成功/失败
		5. LoopNode：output 为最后一次迭代的最终节点输出
		6. API Node：exit_code 为 HTTP 状态码（2xx 为 0，其余为实际状态码）
	2. 开始节点
		1. 开始节点只有一个，为虚拟节点，可以绑定多个次级节点
		2. 在 yaml 中，如果没有 depends_on 直接就是绑定在开始节点上
		3. 实际上开始节点的参数就是根 yaml 的参数
	3. 依赖关系通过 depends_on 数组进行构建
		1. 结构解析阶段自动扫描 ${{ }} 中引用的 node_id，未声明的依赖自动补充到 depends_on
		2. 解析阶段严格校验：环检测（拓扑排序）、依赖存在性检查、变量引用合法性（引用的节点必须在 depends_on 列表中）
		3. 校验失败立即报错，输出具体行号和字段，不进入执行阶段
	4. ShellNode（基于 ProcessExecutable）
		1. 环境变量注入方式
		2. 前后节点的数据获取方式
			1. 显式引用 ${{ nodes.<node_id>.output.stdout }}，不存在 prev 隐式变量
			2. 后置输出使用统一格式
		3. 进入条件的判断
			1. 通过 condition 字段声明表达式，如 condition: "${{ nodes.step1.status }} == 'success'"
		4. 超时与重试
			1. timeout: 节点级超时（秒），超时后标记 FAILED 触发重试或跳过
			2. retry: { count: 重试次数, delay?: 间隔秒数(默认1), backoff?: 'fixed'|'exponential'(默认fixed) }
			3. 默认值策略：Shell 节点默认不重试，Agent 节点默认重试 2 次指数退避
			4. backoff 实现内部加随机 jitter 防止雪崩，用户无需配置
	5. AgentNode（基于 RemoteExecutable）
		1. 通用 ACP 协议封装为指令
		2. 所有 Agent 默认不在同一个机器上，通过 Transport 接口桥接
		3. 输入
			1. 支持输入提示词中写入 ${{ }} 来注入变量
		4. 输出
			1. 使用统一输出格式
			2. node.completed 事件的 metadata 中附加 token 统计：{ tokens: { input, output }, model, latency_ms }
		5. 参数
			1. skill：默认加载的 skill
			2. agent: 定义触发的 agent 名称
		6. 生命周期
			1. AgentNode 区别于 ShellNode：Agent 有服务端状态，需要 abort() 优雅终止（发送 cancel 消息）
			2. 执行接口统一使用 AbortSignal，适配器自行决定 SIGKILL（Shell）还是 cancel（Agent）
	6. API Node（基于 RemoteExecutable）
		1. 主动发送 HTTP/HTTPS 请求，支持 GET/POST/PUT/DELETE
		2. 支持 headers 和 body 模板，通过 ${{ }} 注入变量
		3. 使用统一输出格式
	7. 审批节点（基于 AwaitableExecutable）
		1. 图进入 SUSPENDED 模式
		2. 审批时生成 approval_token（HMAC 签名，非裸 UUID），绑定过期时间（默认 24h，可配）
		3. 审批恢复双模式：CLI 命令 acp approve 或 HTTP API，核心代码不变
		4. HTTP 模式：外部系统调用 POST /workflows/{run_id}/nodes/{node_id}/approve
		5. CLI 模式：acp approve <run_id> <node_id> --token <token>
	8. SubWorkflowNode（子流程引用）
		1. type: workflow，引用外部 yaml 文件作为子流程
		2. 独立运行模型：子流程作为独立 DAG 运行，拥有自己的 run_id 和事件流
		3. 父节点通过 ${{ nodes.<node_id>.output.json.xxx }} 引用子流程输出
		4. 参数传递：SubWorkflowNode 的 params 字段映射到子流程的 params，如 params: { input: '${{ nodes.step1.output.json.data }}' }
		5. 默认行为：子流程失败 → 父节点标记 failed → 触发标准错误传播
		6. 可选 ignore_errors: true：子流程失败 → 父节点仍然 completed，输出包含 { status: 'failed', error: '...' }
		7. 事件流中记录 sub_workflow.started / sub_workflow.completed，支持 drill-down 查看
		8. 嵌套深度无硬限制，但建议不超过 3 层
	9. LoopNode（循环节点）
		1. 内部包含一个子 DAG，每次迭代执行子 DAG
		2. 子 DAG 的节点 id 与父 DAG 隔离（独立命名空间），表达式按执行上下文解析
		3. condition 在每次迭代完成后求值（do-while 语义），可引用子 DAG 内任意节点的输出
		4. max_iterations 限制最大迭代次数，防止无限循环
		5. 每次 loop 迭代在事件流中记录 loop.iteration_started / loop.iteration_completed
		6. DAG 本身保持无环，LoopNode 内部的循环语义封装在节点内部
		7. output 为最后一次迭代的最终节点输出
		8. 多次迭代共享同一工作目录，需要注意写文件冲突
5. 状态存储（Event Sourcing）
	1. 借鉴 Temporal：每个状态变更记录为不可变事件，恢复时通过重放事件流重建状态
	2. DAG 运行状态
		1. PENDING（已解析等待执行）
		2. RUNNING（执行中）
		3. SUSPENDED（暂停，审批节点等待时进入）
		4. FAILED（节点执行失败导致——进程退出码非 0、Agent 连接超时、API 返回错误等）
		5. CANCELLED（用户主动取消，Ctrl+C）
		6. ERROR（调度器系统异常——数据库不可写、未捕获异常、内存溢出等，需人工介入）
		7. SUCCESS（全部完成）
	3. 节点级状态
		1. PENDING（等待执行）
		2. RUNNING（执行中）
		3. COMPLETED（执行完成）
		4. FAILED（执行失败）
		5. CANCELLED（被取消）
		6. SKIPPED（被跳过，依赖链中断或条件不满足）
	4. 事件 Schema（统一事件类型 + 节点类型标签）
		1. DAGEvent 结构：{ event_id, run_id, project_id, node_id, timestamp, type, node_type?, metadata? }
		2. node_type 枚举：shell | agent | api | audit | workflow | loop
		3. 通用事件类型
			1. dag.started（DAG 开始执行，metadata: { params }）
			2. dag.completed（DAG 执行完成，metadata: { status, duration_ms }）
			3. dag.cancelled（DAG 被取消，metadata: { reason }）
			4. node.started（节点开始执行，metadata: { inputs, pid? }）
			5. node.completed（节点执行完成，metadata: { exit_code, output_size, output_ref }）
			6. node.failed（节点执行失败，metadata: { error, exit_code }）
			7. node.cancelled（节点被取消，metadata: { reason }）
			8. node.retrying（节点即将重试，metadata: { attempt, next_delay_ms }）
			9. node.skipped（节点被跳过，metadata: { reason: 'upstream_failed' | 'condition_false' }）
			10. sub_workflow.started（子流程启动，metadata: { sub_run_id }）
			11. sub_workflow.completed（子流程完成，metadata: { sub_run_id, outputs }）
			12. loop.iteration_started（循环迭代开始，metadata: { iteration, max_iterations }）
			13. loop.iteration_completed（循环迭代完成，metadata: { iteration, will_continue }）
			14. audit.requested（进入审批等待，metadata: { approval_token, expires_at, display_data }）
			15. audit.approved（审批通过，metadata: { approval_token }）
		4. Agent 节点最小扩展：只在 node.completed 的 metadata 中加 token 统计，不增加新事件类型
		5. 不记录 node.stdout / node.stderr 事件（避免事件量爆炸）
	5. 节点输出存储
		1. 节点的 stdout/stderr 不写入事件流
		2. MVP 阶段直接同步写入数据库的独立输出表，MQ 接口在 StorageAdapter 中预留供未来扩展
		3. 事件流中 node.completed 只记录 { output_size, output_ref }（引用）
		4. 节点间数据传递通过 ${{ nodes.<node_id>.output.xxx }} 从输出存储中读取
		5. 小输出（<1MB）可内联到事件 metadata 中方便查询，大输出走引用
	6. 存储层设计（可插拔）
		1. StorageAdapter 接口：appendEvent / getEvents / getLatestSnapshot / createSnapshot / listRuns / getOutput / setOutput
		2. 默认实现 SQLite（单文件数据库，WAL 模式支持并发读，better-sqlite3 或 drizzle-orm）
		3. 数据库文件位于 ~/.acp/events.db（全局），通过 project_id 字段隔离不同项目的数据
		4. listRuns 按 project_id 过滤，acp 命令自动从当前工作目录推断 project_id
		5. 可选实现 PostgreSQL / MySQL 适配器，用户通过配置切换
	7. Snapshot 策略
		1. 每个节点完成时生成快照（不在中间做快照）
		2. Snapshot 写入与事件追加在同一个数据库事务中，保证原子性
		3. 快照内容：{ snapshot_id, run_id, last_event_id, timestamp, node_states: Map<node_id, {status, exit_code}> }
		4. 只存节点级状态摘要，不存输出内容
		5. 已完成 DAG 的快照永久保留作为最终状态记录
	8. 恢复机制
		1. 崩溃后从数据库加载最近的 Snapshot
		2. 从 Snapshot 对应的 event_id 之后重放所有事件
		3. 发现 node.started 但无 node.completed/failed/cancelled 的节点 → 检查 PID 是否存活 → 存活则 SIGTERM/cancel → 记录 node.cancelled → 根据重试策略决定是否重新执行
		4. 将未完成的节点重新调度执行
	9. Secrets 脱敏
		1. 事件写入时自动替换已知 secret 值为 ***
		2. 调度器维护 secretValues 集合，事件 metadata 中的字符串做 replace
6. YAML 结构定义
	1. 根结构为扁平式：name / description / params / secrets / timeout / nodes
	2. 变量语法采用 ${{ }} 表达式（严格子集）
		1. 命名空间通过前缀区分
			1. nodes.<id>.output.xxx —— 节点输出引用（如 nodes.step1.output.stdout）
			2. nodes.<id>.status —— 节点状态引用（如 nodes.step1.status）
			3. params.xxx —— 根参数引用（如 params.input_text）
			4. secrets.KEY —— 密钥引用（如 secrets.API_KEY）
		2. 支持：属性访问（a.b.c，含数组索引 a[0]）、比较运算（==, !=, >, <, >=, <=）、逻辑运算（&&, ||, !）、三元表达式（a ? b : c）、字符串拼接（+）
		3. null 语义：属性不存在返回 null，null == null 为 true，null 参与其他比较为 false
		4. 不支持：map/filter/reduce、函数调用、复杂运算、任意 JS 表达式
		5. 复杂数据变换逻辑 drop 到 Shell 节点，通过 jq 或其他工具处理
	3. 节点通过显式 id 字段标识
	4. 节点间引用：${{ nodes.<node_id>.output.stdout }}、${{ nodes.<node_id>.output.json.field }}
	5. 支持多文件 import，通过 SubWorkflowNode 引用外部 workflow
	6. 相对路径基于当前 YAML 文件所在目录解析
	7. schema_version 字段标记版本（初始为 1），永远向后兼容
	8. 工作目录：共用全局目录（YAML 文件所在目录），不创建额外隔离目录，并行写冲突由用户负责
7. Secrets 管理
	1. DAG 级声明 secrets 列表（只是声明需要哪些密钥）
	2. 节点中通过 ${{ secrets.KEY }} 引用
	3. 实际值来源优先级
		1. 系统环境变量
		2. 项目目录下的 .env 文件（加入 .gitignore）
		3. --env-file CLI 参数指定的文件
	4. 运行时作为环境变量注入到节点进程中，不落盘到 YAML 或事件流
8. 执行调度
	1. 中心调度器模式，维护 DAG 状态并分发任务
	2. 扇出场景默认并行执行
	3. DAG 级 timeout 控制整体超时
	4. 错误传播策略
		1. 节点失败时终止所有直接或间接依赖它的下游节点（标记为 SKIPPED）
		2. 不依赖失败节点的其他分支继续执行
		3. DAG 最终状态：全部成功 → SUCCESS，有任何节点失败 → FAILED
	5. 取消机制
		1. 用户 Ctrl+C 触发取消
		2. 调度器停止调度新节点
		3. 向所有运行中节点发送 abort 信号：ProcessExecutable 发 SIGTERM，RemoteExecutable 发 cancel，AwaitableExecutable 标记过期
		4. 等待 grace period（如 10s），超时则 SIGKILL
		5. 记录 dag.cancelled 事件
		6. 不加 on_error 回调，补偿逻辑 drop 到外部脚本
9. 可观测性
	1. 结构化日志：JSON 格式输出到 stderr，包含 run_id / node_id / timestamp / level / message
	2. 事件流即 Trace：Event Sourcing 本身提供完整的执行历史
	3. CLI 查询命令：acp trace <run_id> 格式化输出时间线和关键指标
	4. 不引入 OpenTelemetry 等外部可观测性框架
10. 可视化编辑器
	1. 借鉴 Dify/n8n 的画布体验，但坚持"文件夹即项目"理念
	2. 编辑器直接读写 YAML 文件：拖拽节点 → 实时修改 .yaml；修改 .yaml → 画布自动更新
	3. 用户的所有操作都可以用 git 版本控制
	4. 精确的 YAML 位置追踪（保留注释、格式）为理想目标，MVP 阶段可降级为规范化输出
11. CLI 工具
	1. 本地测试
		1. acp dry-run <workflow.yaml> 完整校验（YAML 语法、环检测、depends_on 存在性、变量引用合法性、表达式语法校验）并展示执行计划（拓扑排序 + 预估并行分支）
		2. acp run-node <workflow.yaml> <node_id> --mock-input '{"stdout":"..."}' 单独执行某个节点并注入模拟前置输出
	2. 正式执行
		1. acp run <workflow.yaml> --params '{"input_text": "hello"}'
		2. acp ls 查看当前项目的运行历史（按 project_id 过滤）
		3. acp trace <run_id> 查看某次运行的事件流
		4. acp output <run_id> <node_id> 查看特定节点的输出
	3. 审批
		1. acp approve <run_id> <node_id> --token <token>
	4. Schema 迁移
		1. 当确实需要破坏性变更时，提供 acp migrate <workflow.yaml> 自动升级工具
