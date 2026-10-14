# 工程债务与优化项

---

## 当前优化项

本页只登记已确认但尚未纳入当前交付范围的优化项。适用的长期规则见
[工程架构与开发规范](./engineering-standards.md)，边界例外见[边界豁免与依赖残留](./boundary-exemptions.md)。

---

## 待延期执行项 & 待优化项

| 项 | 裁定依据 | 终局前提 |
| --- | --- | --- |
| `resource_permission` 表 + 3 个 pgEnum（+ `share_link`、`share_event_snapshot`）仍在宿主 `schema.ts` | §10.3.4 明确：读者/写者/出口已全删，表延至**下一发布** DROP，用于核验 `visibility` 回填结果 | 下一发布执行 DROP；`share_link` / `share_event_snapshot` 需补 `removeWhen` 标注（原登记在已删除的 C7 行，要求本身仍有效） |
| 1 条模块级数据迁移仍由宿主持有（四资源 `visibility` 回填） | 跨包 `./db` 读写经用户裁定登记为 carve-out | 与 B1 同批迁入 owner 包。注：agent-config 的 `model_id` 回填已随 B1 落位 `packages/resources/agent-config/db/data-migrations/`，本行 2026-09-25 相应更正 |
| **migration smoke**（2026-09-22 裁定降级为**优化项**） | 迁移已在真实库经 `docker-compose.yml:65` 增量路径跑通；CI 对空库/升级库的自动化 smoke 不再作为验收必须项，登记见 `ce-ee-engineering-standards.md` §11「优化项（非必须）」 | 无。若落地，验收口径为 `ce-ee-engineering-standards.md` §11 |
| **日志内容脱敏**（2026-09-22 裁定降级为**优化项**） | 13 处把 prompt 正文与 Agent 响应截断后写入日志；脱敏不在本轮范围，登记见 `ce-ee-engineering-standards.md` §11。注意 §7 的 token / Cookie / 密码 / 连接串红线不受影响，仍为必须 | 无。若落地，验收口径为 `ce-ee-engineering-standards.md` §11 |
| **deploy-preflight**（2026-09-22 裁定降级为**优化项**） | 部署前置的只读校验（env / DB 连通性 / 迁移状态 / 镜像版本 / 依赖服务）；现状由容器启动命令 `bun migrate.js && …` 兜底，属「边做边发现」。五类校验中依赖服务健康检查需先给 `ModuleManifest` 加字段，故「部署前置主动探测」不宜作为本轮必须先决项；**该字段本身的必须性来自 §8 明文（未降级），已随 A3 落地**（`ModuleManifest.dependencyServices` + 部署生成与探针），本条只欠「启动前主动探测」；登记见 `ce-ee-engineering-standards.md` §11 | 无。若落地，验收口径为 `ce-ee-engineering-standards.md` §11 |
| **发布物清单 / `build-release`**（2026-09-22 裁定降级为**优化项**） | 发布物附带版本清单 / SBOM / 兼容说明 / migration manifest / env manifest，由 `build-release` 脚本产出；现状只带 `commitId` 且脚本不存在。§8 脚本表与 §10.6.5 已同步收窄，登记见 `ce-ee-engineering-standards.md` §11 | 无。若落地，验收口径为 `ce-ee-engineering-standards.md` §11 |
| **镜像清单 / `build-release`**（2026-09-22 裁定降级为**优化项**） | 镜像清单与版本信息属发布物范畴，随上条「发布物清单」一并降级。Compose、Dockerfile 与无密钥部署模板的当前归属是 `docker/`；部署模板为根 `.env.example`、`docker/main/.env.example` 与 `docker/deploy.env.example`。 `deploy/` 保留 `assembly/`，不再承载容器交付物。 | 无。若落地，验收口径为 `ce-ee-engineering-standards.md` §11 |
| **readiness 与发布证据**（2026-09-22 裁定降级为**优化项**） | readiness 端点、备份点、失败回滚、不可逆迁移补偿证据；现状 `/health` 只表达进程存活。§10.6.5、§10.7.3 与 §6.2 规则 5 已同步收窄，登记见 `ce-ee-engineering-standards.md` §11 | 无。若落地，验收口径为 `ce-ee-engineering-standards.md` §11 |
| **§6.2 迁移规则「生产先备份并执行 migration preflight」**（2026-09-22 裁定整条移入**优化项**） | 备份点归 §11「readiness 与发布证据」，preflight 归 §11「deploy-preflight」；§6.2 现只保留规则 1–4 | 无。若落地，验收口径为 `ce-ee-engineering-standards.md` §11 |
| **2 个历史迁移 ID 不按 §6.3 命名**（`migrate-agent-config-model-id`、`migrate-skill-storage-by-organization`）（2026-09-22 裁定**规范豁免**） | 二者已在 `data_migrate_record` 落库，改名会被 runner 判为未应用而重跑。§6.3 已修正为「ID 落库即发布契约、已应用的迁移不改名，命名格式只约束新增迁移」，因此不计为未满足 | 无 |
| **不可变 DDL 链位于仓库根 `drizzle/` 而非 `db/migrations/`**（2026-09-22 裁定**规范对齐**） | `drizzle.config.ts` 的 `out` 与 `scripts/migrate.ts` 的 `migrationsFolder` 都显式指向 `./drizzle`；搬进 `db/` 要同步两处配置并移动 28 条已发布 SQL、snapshot、journal 与 README（含基线化命令）且无行为收益。§6.1 与目录结构 §1 已改为以仓库根 `drizzle/` 为准 | 无 |
