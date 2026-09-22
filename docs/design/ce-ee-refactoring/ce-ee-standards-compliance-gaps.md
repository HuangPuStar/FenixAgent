# CE/EE 工程规范符合性核查：未满足点

- **核查对象**：`ce-ee-engineering-standards.md`（目标架构与开发规范）、`ce-ee-engineering-directory-structure.md`（目录与归属）
- **核查时点**：2026-09-22，分支 `refactor/arch`
- **核查方式**：按规范章节拆 7 个维度并行读码核查，每条发现再交独立代理对抗性复核（结果 48 条确认 / 2 条驳回）；门禁与构建全部实跑，不采信历史文档结论
- **总体结论**：**架构骨架已落地，主体满足规范**；剩余差距集中在**交付链路（§8）**、**数据迁移完整度（§6.3）**，以及少量**分层越界与宿主残留**。其中阻塞终局验收的集中在交付链路与数据迁移两处。

---

## 一、已验证通过（客观证据）

| 项 | 结果 |
| --- | --- |
| `bun run check:dependencies` | ✓ 2288 modules，10 条已登记例外，0 条新增违规 |
| `bun run architecture:check` | ✓ 2146 files，10 rules，5 条已登记例外 |
| `bun run build:web` | ✓ 成功（exit 0） |
| `bun run docs:build` | ✓ 成功（exit 0） |
| `bun run precheck` | ✓ All passed (85362ms)：15 步全绿；server 808 / package 8006 / web 319 用例，0 fail |
| 宿主路由聚合（§3.1） | 已收敛为 `routes/{web,api}/index.ts` + 模块贡献，无领域 route 残留 |
| Platform 分包（§10.3.1） | `platform-sdk` 无 DB/route/Web，仅 `zod` 依赖；identity / access-control 保持两包 |
| 装配机制（§2.4） | `apps/generated/{module-registry,web-contributions}.ts` 为生成物；`deploy/assembly/ce.json` 只含模块 ID |
| DB owner（§6.1） | 17 个包有 `fenix.module.ts`；`drizzle.config.ts` 声明 15 条 schema 路径；宿主 schema 只剩三类内容 |
| 包 README（§10.1.3） | 13 个资源包 + 3 个平台包 + agent-runtime 均有 README |

---

## 二、未满足点

### A. 交付链路（§8）——最集中的缺口

| # | 缺口 | 规范条款 | 现状证据 |
| --- | --- | --- | --- |
| A1 | `release` 不存在：迁移 → 部署 → 失败判断无统一入口 | §8 脚本表 | 发布编排实为容器启动命令内嵌迁移 |
| A2 | `deploy/` 只有 `assembly/`，缺 `compose/`、`images/`、`env/`、`manifests/`；编排散落仓库根与 `docker/**`，无 profile/overlay 可独立启停模块 | §8；目录结构 §1 | `find deploy -type f` 仅得 `assembly/ce.json` + `README.md` |
| A3 | manifest 无「依赖服务 + 健康检查」字段，部署入口未按装配 profile 生成编排；profile 路径硬编码在应用源码 | §8 | `ModuleManifest` 类型无相关字段 |
| A4 | 无 `deploy/env` 模板；根 `.env.example` 与 `docker/prod/.env.example` 相对模块 `envDefinitions` 已整体过期（分别缺 20/59、28/59 键） | §5.4、§8 | 部署模板无单一真相来源，env manifest 无可交付物 |

### B. 数据迁移（§6.3、§10.6.2）

| # | 缺口 | 规范条款 | 现状证据 |
| --- | --- | --- | --- |
| B1 | `packages/**/db/data-migrations/` 目录全仓不存在；3 个数据迁移无一按模块归属落位 | §6.3 | 2 个在 `apps/server/src/services/data-migrates/`，1 个在 skill 的 `src/server/services/data-migrates/` |
| B2 | 迁移契约只有 `name` + `run`，缺 `dependsOn` / `verify` / `compensation` / 预期数据量 / 锁风险 / 可观测字段；`data_migrate_record` 表只有 `id/name/createdAt`，无法记录批次进度 | §6.3、§10.6.2 | `db/data-migration-runner.ts` 及其契约 |

### C. 后端分层与授权（§3、§10.3）

| # | 缺口 | 规范条款 | 现状证据 |
| --- | --- | --- | --- |
| C1 | 站点路由层自行解释成员角色与 site 可见性（owner/admin 写权限、private 读过滤），未走 `AccessControlModule`/`ResourceScopeStore`；`agent_site_app` 带 `visibility` 列却未注册为受控资源 | §3.3、§10.3.2 | `agent-site-route-support.ts:23-29`、`:52-63` |
| C2 | 多个资源包 route 直接调用 repository 函数（route → 持久化越层），并在路由自行拼装组织条件 | §3.2 依赖方向 | 无 Facade/service 收口 |
| C3 | 资源包领域 service 直接以 `ActorContext` 为形参（授权应止于 Facade） | §3.2、§10.3.2 | agent-config 的 `generateAgentConfig`/`listVisibleSkills`/`resolveSkillIds` |
| C4 | `prod-view` 等非受控资源包**没有 Facade 层**，route 把宿主 `AuthContext` 交给领域服务、由服务按 `organizationId`/`userId` 自行过滤 | §3.2、§3.3 | — |
| C5 | `/api/models` Provider 列表忽略 Facade 的 `limit`/`offset`，全量取出后协议层内存切片；Provider 子资源列表同 | §3.2 | 与同仓决策 D3「不再全量读出后内存切片」相悖 |
| C6 | skill `/api` 在路由内联产品约束与冲突口径、knowledge `/api` 在协议层合并可见集并内存分页 | §10.5.4 | `/api` 与 `/web` 未收敛到同一薄 adapter |
| C7 | `share_link` / `share_event_snapshot` 在全仓零引用，却无 `removeWhen` 或具名移除条件（三张旧表只有 `resource_permission` 标了） | §10.3.4 | `apps/server/src/db/schema.ts` |
| C8 | API Key 路径的 actor 由 key metadata 合成单条 membership、角色为创建期快照，与 `platform-sdk`「memberships 为全量成员关系」契约不符；角色被降级后 key 仍按旧角色授权 | §3.3、§10.3.5 | `toActorContext` 回退分支 |
| C9 | `AuthorizedResourceQuery` 的 SQL 查询层实现无任何测试导入：跨组织/private/public 回归只到谓词评估层 | §10.3.5 | 列解析、`scopeOfRow` 与真实 SQL 无覆盖 |

### D. 前端归属（§4.1、§10.5.2）

| # | 缺口 | 规范条款 | 现状证据 |
| --- | --- | --- | --- |
| D1 | 聊天会话容器簇仍整体驻宿主：`apps/web/src/pages/agent-panel/` 10 文件约 1.4k 行 | §10.5.2、§4.1 | `ChatArea.tsx` 414 行、`use-chat-panel-runtime.ts` 437 行、`ChatPanel.tsx` 192 行等 |
| D2 | 文件域 web 实现全部留在宿主：`api/fs.ts`（319 行 `/web/files` 客户端）+ 文件树/工件容器 | §10.5.2、§9 归属表 | `FileTreeTab.tsx` 475 行、`FileTabsBar.tsx` 211 行等；machine 包侧无 fs 客户端与文件树容器 |
| D3 | `task` 资源域 query hook 仍在宿主：`apps/web/src/hooks/use-task-views.ts`（240 行） | §10.5.2 | `packages/resources/task/web` 下无对应实现 |
| D4 | 宿主仍自持 `agentPanel`（102 叶子键）与 `components`（103 叶子键）两份字典，而键被多个资源包页面消费 | §4.1、§10.5.2 | 键的 owner 与消费方分属两侧 |
| D5 | 预览工具存在两份平行实现：宿主 `apps/web/src/components/agent-panel/preview/utils.ts`（234 行）与 `packages/ui-components/web/components/preview/preview-source.ts`（181 行）导出同名同义符号 | §10.1.1 无重复实现 | 宿主侧实际只用其中一个函数 |
| D6 | 两个宿主 API client 未按已裁定 owner 归位：`api/peri-task-details.ts`（owner 为 model-management）、`api/instances.ts`（应随 agent-runtime web） | §10.5.2 | 既不在包 `./web` 出口，也未登记为残留 |
| D7 | 资源包 web 内仍有多处硬编码中文用户可见串（task 的 `describeCron` 收了 `t` 却不用、zod 校验消息、model-management 页徽标） | §4.1 | 未走 `t()` 与模块字典 |
| D8 | 宿主若干模块已零生产消费，仅由自身测试续命且无移除登记：`App.tsx`、`lib/retry.ts`、`lib/form-utils.ts`、`lib/api-result.ts`、`api/helpers.ts` | §10.7.4 | — |

### E. 依赖声明与包边界（§2.1、§2.3）

| # | 缺口 | 规范条款 | 现状证据 |
| --- | --- | --- | --- |
| E1 | **`machine → agent-config` 是 §2.3 矩阵外的反向边**，取数走 agent-config 模块单例 + `/server` barrel，撞上矩阵对 machine「不得回调 repository、singleton 或生命周期实现」的措辞；该边未进入权威矩阵，只在台账以 `no-circular` 指纹登记 | §2.3、§10.2.2、§10.7.4 | `packages/resources/machine/src/server/services/remote-file-service.ts:1`、`registry.ts:1`；矩阵无任何 machine → resources 规则，故门禁拦不住 |
| E2 | 该反向边的实际读取点 `getAgentConfigById(env.agentConfigId)` 未传 `organizationId`，机器文件路径不按归属校验 agent_config | §10.3.5 租户隔离 | 同上 |
| E3 | 6 处跨模块 `db` 表对象导入落在 `src/**`（均在 `src/__tests__/`），依赖门禁未拦截 | §2.2、§6.1 | 调用期不得导入对方 `db/schema` |

### F. 环境变量与应用基础设施（§5）

| # | 缺口 | 规范条款 | 现状证据 |
| --- | --- | --- | --- |
| F1 | chat-channel 持久层在包内直读宿主声明的 `RCS_YJS_SNAPSHOT_*` 三项，绕过应用基础设施；该直读未在 `exceptions.json` 登记 | §5.2、§10.6.3、§10.7.4 | 台账只收依赖边界条目，无 env 条目 |
| F2 | 引擎插件包直读 `process.env` 取已声明的部署配置：`WORKSPACE_ROOT`（owner 为 agent-runtime）被插件自带第二份解析与 fallback；`RCS_CCB_COMMAND`/`RCS_CCB_ARGS` 在宿主声明且宿主零消费者，唯一取值路径是插件直读 | §5.2、§10.6.3 | plugin-ccb / plugin-opencode 无 `fenix.module.ts`，`envDefinitions` 对其结构性不存在 |
| F3 | 多处 `spawn`/`execFile` 未传 `env` 选项，直接继承整个 `process.env` | §5.4 白名单 | LibreOffice 转换（处理用户上传文档）、slurm ssh 远端命令 |
| F4 | `resolveSystemTenant()` 在实现上执行写操作——幂等引导会 INSERT `user`/`account`/`organization`/`member` 并写系统管理员密码文件，超出「进程级只读投影」定义 | §5.3 | 该入口在 CLAUDE.md 与宿主 `env.ts` 均被描述为只读读法 |

### G. 日志（§7）

| # | 缺口 | 规范条款 | 现状证据 |
| --- | --- | --- | --- |
| G1 | 控制台系统日志页直接枚举、按行读取并流式下载底层 `.log` 文件，无权限过滤的日志投影层 | §7「只读取经过权限过滤的日志投影，不得直接暴露底层日志文件」 | 日志页绕过任何投影层直读文件系统 |
| G2 | 异步任务 / 实例 / 队列 / relay 的显式输入与诊断日志未保留触发方 `requestId`，独立调度入口也未自建关联 ID | §7 | `requestId` 只存在于 HTTP 插件与权限消息字段 |

### H. 文档与验收登记（§10.7.4）

| # | 缺口 | 规范条款 | 现状证据 |
| --- | --- | --- | --- |
| H1 | `docs/operations/`（部署、升级、迁移、备份、排障）不存在 | 目录结构 §1 | `docs/` 下无该目录 |
| H2 | ADR 仅 1 篇（`0001-ce-local-refactoring-and-api-boundaries.md`） | §10.7.4 关键架构决策同步 ADR | `docs/adr/` |
| H3 | 15 条架构例外 owner 均为「未排期」（10 条 `no-circular` + 5 条 `undeclared-workspace-dependency`），无一有在排承接任务 | §10.7.4「必须逐条登记并写明 owner 与移除条件」 | `scripts/architecture/exceptions.json` |
| H4 | 根 `scripts/` 不在 tsconfig 的 `include` 内（`tsc --noEmit` 不检查）；包级 tsconfig 不在任何门禁内 | §10.7.4 | `tsc -p packages/agent-runtime/tsconfig.json` 实测 26 条既有错误 |

---

## 三、已裁定延期或降级（不计为未满足）

| 项 | 裁定依据 | 终局前提 |
| --- | --- | --- |
| `resource_permission` 表 + 3 个 pgEnum（+ `share_link`、`share_event_snapshot`）仍在宿主 `schema.ts` | §10.3.4 明确：读者/写者/出口已全删，表延至**下一发布** DROP，用于核验 `visibility` 回填结果 | 下一发布执行 DROP；`share_link` / `share_event_snapshot` 需补 `removeWhen` 标注（见 C7） |
| 2 条模块级数据迁移仍由宿主持有（agent-config 的 `model_id` 回填、四资源 `visibility` 回填） | 跨包 `./db` 读写经用户裁定登记为 carve-out | 与 B1 同批迁入 owner 包 |
| 6 条 `machine ↔ agent-config ↔ agent-runtime ↔ sandbox` 的 `no-circular` 指纹 | owner「未排期」，共同闭合边为 E1 | E1 消除后一并退场 |
| **migration smoke**（2026-09-22 裁定降级为**优化项**） | 迁移已在真实库经 `docker-compose.yml:65` 增量路径跑通；CI 对空库/升级库的自动化 smoke 不再作为验收必须项，登记见 `standards.md` §11「优化项（非必须）」 | 无。若落地，验收口径为 `standards.md` §11 |
| **日志内容脱敏**（2026-09-22 裁定降级为**优化项**） | 13 处把 prompt 正文与 Agent 响应截断后写入日志；脱敏不在本轮范围，登记见 `standards.md` §11。注意 §7 的 token / Cookie / 密码 / 连接串红线不受影响，仍为必须 | 无。若落地，验收口径为 `standards.md` §11 |
| **deploy-preflight**（2026-09-22 裁定降级为**优化项**） | 部署前置的只读校验（env / DB 连通性 / 迁移状态 / 镜像版本 / 依赖服务）；现状由容器启动命令 `bun migrate.js && …` 兜底，属「边做边发现」。五类校验中依赖服务健康检查还需先给 `ModuleManifest` 加字段，不宜作为本轮必须先决项；登记见 `standards.md` §11 | 无。若落地，验收口径为 `standards.md` §11 |
| **发布物清单 / `build-release`**（2026-09-22 裁定降级为**优化项**） | 发布物附带版本清单 / SBOM / 兼容说明 / migration manifest / env manifest，由 `build-release` 脚本产出；现状只带 `commitId` 且脚本不存在。§8 脚本表与 §10.6.5 已同步收窄，登记见 `standards.md` §11 | 无。若落地，验收口径为 `standards.md` §11 |
| **readiness 与发布证据**（2026-09-22 裁定降级为**优化项**） | readiness 端点、备份点、失败回滚、不可逆迁移补偿证据；现状 `/health` 只表达进程存活。§10.6.5、§10.7.3 与 §6.2 规则 5 已同步收窄，登记见 `standards.md` §11 | 无。若落地，验收口径为 `standards.md` §11 |
| **§6.2 迁移规则「生产先备份并执行 migration preflight」**（2026-09-22 裁定整条移入**优化项**） | 备份点归 §11「readiness 与发布证据」，preflight 归 §11「deploy-preflight」；§6.2 现只保留规则 1–4 | 无。若落地，验收口径为 `standards.md` §11 |
| **2 个历史迁移 ID 不按 §6.3 命名**（`migrate-agent-config-model-id`、`migrate-skill-storage-by-organization`）（2026-09-22 裁定**规范豁免**） | 二者已在 `data_migrate_record` 落库，改名会被 runner 判为未应用而重跑。§6.3 已修正为「ID 落库即发布契约、已应用的迁移不改名，命名格式只约束新增迁移」，因此不计为未满足 | 无 |
| **不可变 DDL 链位于仓库根 `drizzle/` 而非 `db/migrations/`**（2026-09-22 裁定**规范对齐**） | `drizzle.config.ts` 的 `out` 与 `scripts/migrate.ts` 的 `migrationsFolder` 都显式指向 `./drizzle`；搬进 `db/` 要同步两处配置并移动 28 条已发布 SQL、snapshot、journal 与 README（含基线化命令）且无行为收益。§6.1 与目录结构 §1 已改为以仓库根 `drizzle/` 为准 | 无 |

---

## 四、优先级建议

1. **先修 E1**（`machine → agent-config` 反向边）：它是 6 条例外指纹的共同闭合边，也是 §10.2 唯一未达的「无环 + 特殊依赖经评审」条目；一次删除可同时清掉 6 条台账。修法二选一——改指 agent-config 的窄入口（`./server/runtime`），或改为宿主注入 lookup 端口（与 E2 的归属校验同批）。
2. **补交付链路 A1–A4**：这是阻塞点最密集的一组，且 §10.6.5 的验收证据几乎全部落在这里。
3. **补数据迁移 B1–B2**：契约字段（`dependsOn`/`verify`/`compensation`）与 `data_migrations/` 目录落位是 §6.3、§10.6.2 的硬要求，需与 carve-out 迁移一并处理。
4. **收敛 C1**（agent-config 站点路由）：这是唯一一处「资源包自行解释成员角色与可见性」的违规，涉及安全边界（原「协议层直查 DB」一半已于 2026-09-22 修复，见核查附注；原 C2「`/api/mcp` 缺领域校验」已于 2026-09-22 修复）。
5. **收敛 C2**（route → repository 越层）：面最广的一处——多个资源包的协议层直接调持久化函数并自行拼装组织条件，是「无 Facade/service 收口」的入口，与 C1 的站点路由残留同源。
6. 其余 minor 项可按 F → G → E3 → D → H 顺序清理。

---

## 核查附注

- 本次核查**不采信** `docs/design/ce-ee-refactoring/review/task-1.*.md` 与阶段计划的结论，全部以规范文档对照当前代码得出；上述各条均带可复核的文件路径或命令证据。
- 复核阶段驳回 2 条误报，已订正：
  - `packages/platform/access-control` 的 `@fenix/identity` **不是**死声明——它是 `fenix.module.ts` 的 `dependsOn` 所需的配套编译依赖，`generate-module-registry` 的 `assertDependsOnDeclared` 强制校验（该误报原与下条的 `apps/server` 死声明同列为一项，后者已于 2026-09-22 修复）。
  - `AuthorizedResourceQuery` 的 `access` 可省略是设计认可口径（`ce-access-control-design.md` §3.4），四资源包的边界测试已落地，C9 因此只保留「SQL 层无测试覆盖」的实际差距。
- **2026-09-22 已修复**：agent-config 站点路由的协议层直查 DB（原 C1）。`agent-site-route-support.ts` 的 creator 名称解析改用 `repositories/agent-config` 的 `findAgentConfigNamesByIds`，`agent-site-association-routes.ts` 的绑定查询改用 `services/config/agent-config-site-app` 的 `listAgentSiteAppIds`；两个路由文件已不导入 `@fenix/agent-config/db`、`drizzle-orm` 与 `../../db`。残留：creator 名称解析这一处仍是 route → repository 直接调用，属 C2 的「无 Facade/service 收口」口径。
- **2026-09-22 已修复**：`/api/mcp` 缺失的 MCP 领域校验（原 C2）。校验收口到 `McpServerFacade` 而非任一 route：`assertCreatable`（名称格式 + 配置结构，权限判定之前）与 `assertValidConfig`（配置结构，写入之前）分别挂在 `create` 与 `applyUpdate` 上，`/web/config/mcp` 原有的两处重复调用已删除，`/api/mcp` 与 `/web` 因此走同一条校验。两个入口的 `response` 均已声明 400，`ValidationError` 由 `mapApiError` / `mapConfigErrorStatus` 映射为 `VALIDATION_ERROR`。
  - 残留（对外契约变更，需单独裁定）：`/api/mcp` 的 `PUT /:id` 请求体 schema 是 `.partial()`（形似字段补丁），但 `McpServerService.update` 覆盖整份 `config` 列。收口后部分配置体（如 `{"timeout":1000}`）会在 Facade 被判为 `INVALID_COMMAND` 而返回 400，不再静默用不完整配置覆盖已存的连接信息。已同步在 OpenAPI 的 `description` 里写明「整份配置、替换语义」；是否进一步把 `ApiMcpUpdateBodySchema` 从 `.partial()` 收紧为必填完整配置，属对外合同变更，未在本轮处理。
- **2026-09-22 已修复**：`apps/server` 的 `@fenix/plugin-sdk` 死声明（原 E3）。删除 `apps/server/package.json` 的 `"@fenix/plugin-sdk": "workspace:*"`，并重新生成 `bun.lock`（`bun install --lockfile-only`，仅同步该一处，其余 13 处 `@fenix/plugin-sdk` 声明不受影响）。删除前已按 §2.1 逐条 grep 全包确认零导入，并排除第二种消费面：`apps/server` 无 `fenix.module.ts`（`apps` 下只有 `apps/web/fenix.module.ts`），全仓 `dependsOn` 亦无该包，故 `assertDependsOnDeclared` 不受影响；`precheck` 全绿。
- **2026-09-22 已修复**：仅测试使用的 workspace 依赖留在 `dependencies`（原 E3）。`apps/server` 的 `@fenix/chat-channel` 移入 `devDependencies`（全包唯一导入点是 `src/__tests__/round15-isolated-service-boundaries.test.ts:5` 与 `round16-isolated-protocol-boundaries.test.ts:3`，`src/env.ts:124` 只是注释提及）；`packages/agent-runtime` 的 `@fenix/ui-components` 同样移入（唯一导入点是 `web/__tests__/use-chat-state-hook.test.tsx:19` 的 `@fenix/ui-components/testing`）。移动前排除第二种消费面：两个位置都不存在引用被移对象的 `dependsOn`（`agent-runtime/fenix.module.ts` 是 `dependsOn: []`，`apps/server` 无 module 描述符），全仓 `dependsOn` 亦无引用；`assertDependsOnDeclared` 只校验 `dependsOn → dependencies` 一个方向，故移出不触发。已同步重生成 `bun.lock`。
- **2026-09-22 已修复**：`web/` 交付物的第三方依赖声明与真实导入面漂移（原 E4）。按 §2.1 的三类判定逐包比对导入面后共修改 12 个 manifest——规则 3（只在测试文件中导入）把 `happy-dom@^20.9.0` 补进 `devDependencies`：agent-config、agent-runtime、channel、knowledge、mcp、model-management、prod-view、skill、task；规则 1（与宿主共用实例的框架库）把 `react-dom@^19.2.6` 补进 `peerDependencies`：agent-runtime、channel、identity、machine、mcp、model-management、prod-view、skill、task，把 `react@^19.2.6` 补进 agent-runtime 与 machine，把 `@tanstack/react-router@^1.170.7` 补进 identity。版本均与根 `package.json` 逐字一致。本条原文有两处需订正：identity 的 `happy-dom` **早已声明**，其真实缺口是 `react-dom` 与 `@tanstack/react-router`，且按规则 1 归 `peerDependencies` 而非 `devDependencies`；`happy-dom` 缺口还包括 `agent-runtime`，不只原文列的 8 个包。判定口径：规则 1 的「该包 `web/` 实际导入」不区分测试与否——同批先例是 `knowledge` 在非测试代码零导入 `react-dom` 的情况下仍把它声明为 peer；规则 3 只覆盖非框架库（原文即举例 `happy-dom` 等 DOM 环境）。`web-runtime` 未纳入：规则 1–3 限定「**资源包** `web/` 交付物」，它是独立 SDK 包，`i18next` 走 `dependencies`、`react-dom` 走 `devDependencies` 的既有形态不受该节约束。
  - 顺带修正三处因补声明而失真的注释（`channel/web/lib/channel-list-state.ts`、`channel/web/__tests__/channel-list-state.test.ts`、`model-management/web/__tests__/vertical-models-filter.test.ts`）：原文以「本包 `package.json` 不含 happy-dom，且任务约束禁止改 `package.json`」解释为何只测纯函数，该理由已不成立，改为陈述稳定理由（被测对象是状态与数据流而非 UI 结构）。
  - 连锁影响（同批处理）：给 agent-runtime 补 `react` peer 后，Biome 的 react domain 由未启用转为启用（该 domain 依包 manifest 内的 react 声明自动判定），由此暴露两个 hooks 中 4 处既有的 `useExhaustiveDependencies` 诊断（`use-chat-state.ts:483`、`:485`，`use-session-state.ts:220`、`:222`）。该模式是刻意的引用驱动依赖——`cleanup` 期 destroy 会清空 store listeners，而 `useSyncExternalStore` 只在 subscribe 引用变化时重订阅，故必须让引用随 `bindEpoch` 变化（SP-B1 回归用例捕获过的真实缺陷）；Biome 对同一行同时给出「未指定 `stores.X.subscribe`」与「`bindEpoch` 多余」两条互相矛盾的建议，属误报，照建议改列 `stores.X.subscribe` 会让每次渲染都重订阅。处置为 4 处带原因的 `biome-ignore` 行级抑制，未改逻辑。
