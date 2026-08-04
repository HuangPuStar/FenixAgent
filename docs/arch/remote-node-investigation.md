# 远程节点使用路径调研报告

> 调研日期：2026-08-04
> 背景：用户环境配置 `RCS_DEFAULT_MACHINE_ID=mach_a42b3831-b818-43a4-ae9`、`RCS_DEFAULT_MACHINE_TYPE=ccb`，远程节点两条路径在新版重构后疑似损坏。
> 方法：三路并行代码探索（注册连接 / 启动节点选择 / 配置定义）+ 交叉核对 + git 历史验证（c71ee18c、0dcb2e2d、cc8fdf6c、637a4cef、2acb88d5、b29f47b6）。

## 核心结论

1. **两条路径的主干结构完整**（编排域收敛成功），"远程节点被当作本地"的怀疑**不成立**——不存在把远程 mach 错解析为 `local-default` 的代码路径（`instance-orchestrator.ts:109` 精确匹配；`environment-orchestration.ts:50-53` 中 `defaultMachineId` 优先于 `local-default`）。
2. 实际损坏集中在：① **配置层死变量**（`RCS_DEFAULT_MACHINE_TYPE`，非重构引入）；② **c71ee18c / cc8fdf6c / 0dcb2e2d 重构引入的三处语义回归**（远程引擎失控、无 agentConfigId 被拒、空串不 fallback）。
3. 最接近"远程被当本地"的真实退化是**空串启动失败**与**无 agentConfigId 环境被拒**。

## 一、两条路径现状

### 路径一：远程节点远程使用（agent 绑定 / fallback → acp-link 执行）

| # | 链路步骤 | 位置 | 状态 |
|---|---|---|---|
| 1 | machineId 解析：`agent_config.machineId ?? config.defaultMachineId ?? "local-default"` | `environment-orchestration.ts:48-53` | ⚠️ 可用，但空串不 fallback（断裂点 4） |
| 2 | `ensureNode(machineId)` → AgentNodeService 远程 WS 节点 | `agent-controller/index.ts:83`、`agent-node-service.ts:75-83` | ⚠️ 机器未连接抛 `AGENT_NODE_UNAVAILABLE`（断裂点 3/6） |
| 3 | `spawnInstanceViaCore` remote 分支**不传 engineType** | `orchestration-instance.ts:81` | 🔴 断裂（断裂点 2） |
| 4 | core：node online 检查 → remote 占位 `"remote"`（跳过 supportsEngine 校验） | `instance-orchestrator.ts:109-136` | ✅ 可用 |
| 5 | runtimeResolver 命中 remoteTransports 缓存 | `core-bootstrap.ts:78-86` | ✅ 可用 |
| 6 | WS prepare 不带 `engine_type` → 机器端用 `defaultEngine = config.agentType ?? "opencode"` | `remote-runtime.ts:24`、`instance-manager.ts:78-88` | 🔴 引擎失控（断裂点 2） |
| 7 | 机器侧启动进程 + 心跳（30s/90s 超时） | `server.ts:509-567`、`acp-ws-handler.ts:194-201` | ✅ 可用 |

### 路径二：远程节点被当本地 / local-default 兜底错位

| # | 场景 | 结论 | 依据 |
|---|---|---|---|
| 1 | nodeId 字符串错配（远程 mach 被解析成 local-default） | ❌ 排除，不存在该代码路径 | `instance-orchestrator.ts:109` 精确匹配；`environment-orchestration.ts:50-53` 中 defaultMachineId 优先于 local-default |
| 2 | `agent_config.machine_id = ""` | 🔴 断裂：`??` 不 fallback，直接抛 `LaunchSpecBuildError` | `environment-orchestration.ts:49` vs 旧路径 falsy 检查（0dcb2e2d^） |
| 3 | 无 agentConfigId 环境（ACP/Bridge） | 🔴 断裂：`getEnvironment` return null → `EnvironmentNotFoundError` | `environment-orchestration.ts:42`、`launch-spec-builder.ts:51-55` |
| 4 | local-default 兜底本身 | ✅ 可用（b29f47b6 恢复）；禁用本地执行 + 无 machineId 时抛错 | `local-node-service.ts:62-78` |

## 二、断裂点清单（按影响排序）

| # | 位置 | 现象 | 根因 | 影响范围 | 重构引入 |
|---|---|---|---|---|---|
| 1 | `docker-compose.yml:45` + `env.ts:75-88` | `RCS_DEFAULT_MACHINE_TYPE=ccb` 完全无效且无告警 | 服务端只认 `RCS_DEFAULT_ENGINE_TYPE`，zod strip 静默丢弃 | **全部**远程部署引擎与预期不符 | 否（637a4cef 07-28 引入即死配置；c71ee18c 后 ENGINE_TYPE 也仅 local 生效） |
| 2 | `orchestration-instance.ts:81` → `instance-orchestrator.ts:189-191` → `remote-runtime.ts:24` → `instance-manager.ts:78-88` | 远程端静默回落 opencode，服务端无法指定引擎 | c71ee18c 将 engineType 控制权下放 ACP Runtime；协议仍支持（server.ts:514 注释）但 RCS 侧无调用方传该字段 | 交互式 Chat / workflow / HTTP 单轮（所有远程执行） | ✅ 是（c71ee18c 07-23） |
| 3 | `registry.ts:184-193` vs `server.ts:307-311` | fallback 目标机器从未连接 → `AGENT_NODE_UNAVAILABLE` | 服务端 `RCS_DEFAULT_MACHINE_ID` 与 acp-link `RCS_MACHINE_ID` 不一致（未配时持久化首次分配 id） | 路径一最常见实际故障 | 否（2acb88d5 既有语义） |
| 4 | `environment-orchestration.ts:49` | `machine_id=""` 直接启动失败，既不 fallback 也不 local | 迁移时 `if (agentMachineId)` 改为 `??`，空串语义变化 | 请求体直传 `machineId:""` 或历史脏数据的 agent | ✅ 是（0dcb2e2d 08-03） |
| 5 | `environment-orchestration.ts:42`、`launch-spec-builder.ts:51-55` | 无 agentConfigId 环境无法启动实例 | 编排域未实现 fallback；违反 CLAUDE.md 不变量（"无 agentConfigId 的 ACP/Bridge environment 同样必须执行 fallback"） | ACP/Bridge 环境实例执行；与文件 API 侧 fallback（`remote-file-service.ts:23-34`）行为分裂 | ✅ 是（cc8fdf6c） |
| 6 | `agent-node-service.ts:75-79` | 机器离线错误从 `MACHINE_OFFLINE` 503 变为 `AGENT_NODE_UNAVAILABLE`，无 HTTP 状态映射（大概率 500） | 编排域错误未接入 route 映射 | 所有 `/web/*` 调用方无法按 503 判断离线 | ✅ 是（cc8fdf6c） |
| 7 | `registry.ts:372-379`、`206-214` | bindAgentConfigs 每次重连覆盖绑定，且 agentName 字段注册时不更新 | 机器命令名与预期不符时自动绑定错 agent | 同组织 `name=opencode` 的 agent 被误绑 | 否 |
| 8 | `instance-orchestrator.ts:121-133` | 声明仅 opencode 的机器照常承接 ccb 请求 | remote 跳过 supportsEngine 校验，真正引擎在机器端 | 无服务端诊断，配置漂移不可见 | 否 |

## 三、配置错位说明（RCS_DEFAULT_MACHINE_TYPE vs RCS_DEFAULT_ENGINE_TYPE）

1. **`RCS_DEFAULT_MACHINE_TYPE` 是死配置**：仅存在于 `docker/prod/docker-compose.yml:45`（637a4cef 引入），`env.ts` / `config.ts` / 全部 `src` 与 `packages` 中不存在。zod v4 `z.object` 默认 strip 未知键（校验 success 且输出无该键）→ **部署的 `MACHINE_TYPE=ccb` 被静默丢弃，不报错**。
2. **`RCS_DEFAULT_ENGINE_TYPE` 语义已收窄**：`env.ts:81` 正常读取，但 c71ee18c 后仅对 **local 执行**生效（commit message 明示）；remote 路径完全不读。
3. **有效控制链**：远程执行引擎唯一真实来源是机器端 `AGENT_TYPE`（acp-runtime-cli `bin.ts:36`，默认 `"opencode"`）。要实现远程 ccb，只能改 acp-link 容器环境变量，服务端任何配置都无法覆盖。
4. **连锁影响**：`ensureMachineExists` 预创建记录 agentName 落 `"opencode"`（`core-bootstrap.ts:38`，取 `defaultEngineType` 而非 `MACHINE_TYPE`）→ 管理面显示与机器实际引擎可能永久错位；设计文档 `docs/design/2026-07-08-system-default-machine-engine-design.md` 未同步 c71ee18c 的语义变化。

## 四、修复建议（按影响排序，最小修复优先）

| 优先级 | 修复 | 改动量 | 说明 |
|---|---|---|---|
| P0 | 配置对齐：compose 改名 `RCS_DEFAULT_ENGINE_TYPE`（或 env.ts 加 MACHINE_TYPE 别名兼容），并补 compose 透传；确认 `RCS_DEFAULT_MACHINE_ID` 透传 | 1-3 行 | 消除死配置；注意 ENGINE_TYPE 只解决 local |
| P0 | 部署对齐：服务端 `RCS_DEFAULT_MACHINE_ID` 与 acp-link `RCS_MACHINE_ID` 必须精确一致；机器侧设 `AGENT_TYPE=ccb` | 部署配置 | 断裂点 1/3 的运维侧修复 |
| P1 | 空串回退：`environment-orchestration.ts:49` 改回 falsy 检查 | 数行 | 修复断裂点 4 |
| P1 | 无 agentConfigId fallback：`getEnvironment` 补 `getRemoteMachineId` 同款 fallback（对齐 `remote-file-service.ts:23-34`），满足 CLAUDE.md 不变量 | 数行 | 修复断裂点 5，消除文件/执行分裂 |
| P2 | 远程引擎控制：恢复传 engineType（协议仍支持，`server.ts:514` 注释）或正式文档化"机器端 AGENT_TYPE 唯一控制"并加启动告警 | 数行或纯文档 | 修复断裂点 2/8 |
| P2 | 错误语义：`AGENT_NODE_UNAVAILABLE` 映射 503，恢复调用方判断能力 | 数行 | 修复断裂点 6 |
| P3 | bindAgentConfigs 收敛：仅首次绑定或加 agentName 诊断日志 | 数行 | 修复断裂点 7 |
| P3 | 同步设计文档（c71ee18c 语义变化）+ 校验测试：空串、无 agentConfigId、离线节点三场景 | 文档+测试 | 防止回归 |

## 五、验证记录

- `c71ee18c`（07-23）`feat: engineType 控制权下放到 ACP Runtime 层`：commit message 明示 "RCS_DEFAULT_ENGINE_TYPE 保留，仅对 local 生效"、"remote 不传 engineType"——断裂点 2 的直接来源。
- `0dcb2e2d`（08-03）`refactor: 删除旧实例生命周期代码，全部收敛到编排域路径`：`??` 空串语义变化（断裂点 4）。
- `cc8fdf6c` `refactor: 编排域重构集成落地并废弃 agent_session 表`：无 agentConfigId 拒绝 + 错误语义变化（断裂点 5/6）。
- `b29f47b6` `fix: 恢复无 machineId 环境的本地执行（local-default）回退`：local-default 兜底曾被破坏、已恢复。
- `637a4cef`（07-28）`chore: 基础设施`：docker-compose 引入 `RCS_DEFAULT_MACHINE_TYPE` 死配置（断裂点 1）。

## 六、结论

两条路径主干结构完整，实际损坏集中在 ① 配置层死变量（断裂点 1/3，非重构引入），② c71ee18c / cc8fdf6c / 0dcb2e2d 重构引入的三处语义回归（断裂点 2/4/5）。"远程被当本地"的怀疑不成立。**P0 + P1 四项修复即可恢复部署预期行为。**

## 七、修复状态（2026-08-04）

| 断裂点 | 结论 | 处理 |
|---|---|---|
| 1（P0） | `RCS_DEFAULT_MACHINE_TYPE` 死配置 | ✅ 已修复：`docker/prod/docker-compose.yml` 改名 `RCS_DEFAULT_ENGINE_TYPE` 并补 `RCS_DISABLE_LOCAL_EXECUTION` 透传（行为变更：.env 已设 true 者部署后 local 执行被真实禁用）；`.env.example` 同步注释 |
| 2（P2） | 远程引擎失控 | ⚠️ 文档化 + 启动告警（不恢复服务端强制指定）：c71ee18c 有意将控制权下放机器端 `AGENT_TYPE`；`env.ts` 新增 `findDeprecatedEnvVars()`，`index.ts` 启动时对 `RCS_DEFAULT_MACHINE_TYPE` 输出告警；设计/架构文档同步 |
| 3（P2） | fallback 机器未连接 → `AGENT_NODE_UNAVAILABLE` | ⚠️ 遗留（运维侧，非代码）：服务端 `RCS_DEFAULT_MACHINE_ID` 与 acp-link `RCS_MACHINE_ID` 必须精确一致；机器侧设 `AGENT_TYPE` |
| 4（P1） | 空串 machineId 不 fallback | ✅ 已修复：`environment-orchestration.ts` 改回 `||` 空串归一（带设计原因注释），沿 `??` fallback 链解析 |
| 5（P1） | 无 agentConfigId 环境被拒 | ✅ 已修复：仅记录不存在返回 `null`；无 agentConfigId 不再 `EnvironmentNotFoundError`，agentConfig 必填由 LaunchSpecBuilder 在 spawn 层兜底（404 → 422） |
| 6（P2） | `AGENT_NODE_UNAVAILABLE` 无映射 | ✅ 已修复（**更正调研结论**）：`error-handler.ts:15` 的 503 映射在重构时已随 errorPlugin 存在，本次补回归测试 `src/__tests__/error-handler.test.ts` 固化 |
| 7（P3） | bindAgentConfigs 重连覆盖绑定 | ⚠️ 遗留：不在本次范围（见实施蓝图），需单独任务收敛 |
| 8（P3） | remote 跳过 supportsEngine 校验 | ⚠️ 遗留：设计使然（真正引擎在机器端），服务端无法诊断配置漂移 |

**遗留风险**：断裂点 3/7/8 未处理（3 为运维对齐，7/8 为独立任务）；部署文档需同步 `ENGINE_TYPE` 改名（本报告第三节的 compose 引用已随修复更新）。
