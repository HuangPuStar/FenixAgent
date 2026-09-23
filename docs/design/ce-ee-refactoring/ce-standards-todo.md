# 工程规范 待整改项

---

## 待整改项

### A. 交付链路（§8）——最集中的缺口

| # | 缺口 | 规范条款 | 现状证据 |
| --- | --- | --- | --- |
| A1 | `release` 不存在：迁移 → 部署 → 失败判断无统一入口 | §8 脚本表 | 发布编排实为容器启动命令内嵌迁移 |
| A2 | `deploy/` 只有 `assembly/`，缺 `compose/`、`env/`、`manifests/`；编排散落仓库根与 `docker/**`，无 profile/overlay 可独立启停模块（原列于此的 `images/` 属发布物范畴，已按 2026-09-22 裁定降级，见「三」） | §8；目录结构 §1 | `find deploy -type f` 仅得 `assembly/ce.json` + `README.md` |
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

---

## 待延期执行项 & 待优化项

| 项 | 裁定依据 | 终局前提 |
| --- | --- | --- |
| `resource_permission` 表 + 3 个 pgEnum（+ `share_link`、`share_event_snapshot`）仍在宿主 `schema.ts` | §10.3.4 明确：读者/写者/出口已全删，表延至**下一发布** DROP，用于核验 `visibility` 回填结果 | 下一发布执行 DROP；`share_link` / `share_event_snapshot` 需补 `removeWhen` 标注（见 C7） |
| 2 条模块级数据迁移仍由宿主持有（agent-config 的 `model_id` 回填、四资源 `visibility` 回填） | 跨包 `./db` 读写经用户裁定登记为 carve-out | 与 B1 同批迁入 owner 包 |
| 6 条 `machine ↔ agent-config ↔ agent-runtime ↔ sandbox` 的 `no-circular` 指纹 | owner「未排期」，共同闭合边为 E1 | E1 消除后一并退场 |
| **migration smoke**（2026-09-22 裁定降级为**优化项**） | 迁移已在真实库经 `docker-compose.yml:65` 增量路径跑通；CI 对空库/升级库的自动化 smoke 不再作为验收必须项，登记见 `standards.md` §11「优化项（非必须）」 | 无。若落地，验收口径为 `standards.md` §11 |
| **日志内容脱敏**（2026-09-22 裁定降级为**优化项**） | 13 处把 prompt 正文与 Agent 响应截断后写入日志；脱敏不在本轮范围，登记见 `standards.md` §11。注意 §7 的 token / Cookie / 密码 / 连接串红线不受影响，仍为必须 | 无。若落地，验收口径为 `standards.md` §11 |
| **deploy-preflight**（2026-09-22 裁定降级为**优化项**） | 部署前置的只读校验（env / DB 连通性 / 迁移状态 / 镜像版本 / 依赖服务）；现状由容器启动命令 `bun migrate.js && …` 兜底，属「边做边发现」。五类校验中依赖服务健康检查需先给 `ModuleManifest` 加字段，故「部署前置主动探测」不宜作为本轮必须先决项；**该字段本身的必须性来自 §8 明文（未降级），不被本次降级带走，A3 仍计为阻塞缺口**；登记见 `standards.md` §11 | 无。若落地，验收口径为 `standards.md` §11 |
| **发布物清单 / `build-release`**（2026-09-22 裁定降级为**优化项**） | 发布物附带版本清单 / SBOM / 兼容说明 / migration manifest / env manifest，由 `build-release` 脚本产出；现状只带 `commitId` 且脚本不存在。§8 脚本表与 §10.6.5 已同步收窄，登记见 `standards.md` §11 | 无。若落地，验收口径为 `standards.md` §11 |
| **`deploy/images/`**（2026-09-22 裁定降级为**优化项**） | 镜像清单与版本信息属发布物范畴，随上条「发布物清单」一并降级。A2 因此只保留 `compose/`（§8 编排与 profile/overlay）、`env/`（§5.4「`deploy/env/*.example` 是部署模板的真相来源」）、`manifests/`（§2.3 `kind`/`capabilities` 参与 profile 与 preflight 校验）三个有明文出处的子目录 | 无。若落地，验收口径为 `standards.md` §11 |
| **readiness 与发布证据**（2026-09-22 裁定降级为**优化项**） | readiness 端点、备份点、失败回滚、不可逆迁移补偿证据；现状 `/health` 只表达进程存活。§10.6.5、§10.7.3 与 §6.2 规则 5 已同步收窄，登记见 `standards.md` §11 | 无。若落地，验收口径为 `standards.md` §11 |
| **§6.2 迁移规则「生产先备份并执行 migration preflight」**（2026-09-22 裁定整条移入**优化项**） | 备份点归 §11「readiness 与发布证据」，preflight 归 §11「deploy-preflight」；§6.2 现只保留规则 1–4 | 无。若落地，验收口径为 `standards.md` §11 |
| **2 个历史迁移 ID 不按 §6.3 命名**（`migrate-agent-config-model-id`、`migrate-skill-storage-by-organization`）（2026-09-22 裁定**规范豁免**） | 二者已在 `data_migrate_record` 落库，改名会被 runner 判为未应用而重跑。§6.3 已修正为「ID 落库即发布契约、已应用的迁移不改名，命名格式只约束新增迁移」，因此不计为未满足 | 无 |
| **不可变 DDL 链位于仓库根 `drizzle/` 而非 `db/migrations/`**（2026-09-22 裁定**规范对齐**） | `drizzle.config.ts` 的 `out` 与 `scripts/migrate.ts` 的 `migrationsFolder` 都显式指向 `./drizzle`；搬进 `db/` 要同步两处配置并移动 28 条已发布 SQL、snapshot、journal 与 README（含基线化命令）且无行为收益。§6.1 与目录结构 §1 已改为以仓库根 `drizzle/` 为准 | 无 |