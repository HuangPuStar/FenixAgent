# 工程规范 待整改项

---

## 待整改项

**2026-09-25：整改项已清零（0 行未完成）。**

原 12 行——A1–A3（交付链路）、B1（数据迁移归位）、C1/C2/C3/C4/C6（后端分层与授权）、D1/D2/D4（前端归属）——已逐条收敛到
规范条款并经只读核实出账后删除。出账口径是「该行的规范条款在当前工作区逐条成立、证据可复核到 `文件:行`」，
关键断言另做反转实验（把被测判断反转后断言必须失败）。

后续审计的入口不在这份台账，而在三处：

- **规范正文**：`ce-ee-engineering-standards.md`（§3 分层与授权、§4.1 归属、§6.3 迁移、§8 交付链路、§10 一致性要求）。
- **边界豁免与依赖残留**：`boundary-exemptions.md`——§10.7 完成证据第 4 条要求「边界豁免与依赖残留必须逐条登记并写明
  owner 与移除条件」，该文是唯一登记处；代码文件头的登记段只是摘要。
- **关键裁定**：`docs/adr/`（`/api` 合同变更、站点发布面解释权）。

**新增缺口按同样的四列格式在此追加**（`# | 缺口 | 规范条款 | 现状证据`），不要另立台账；
已收敛的条目直接删除，不保留「已完成」痕迹——本文件只描述**还欠什么**。

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
| **`deploy/images/`**（2026-09-22 裁定降级为**优化项**） | 镜像清单与版本信息属发布物范畴，随上条「发布物清单」一并降级。A2 因此只保留 `compose/`（§8 编排与 profile/overlay）、`env/`（§5.4「`deploy/env/*.example` 是部署模板的真相来源」）、`manifests/`（§2.3 `kind`/`capabilities` 参与 profile 与 preflight 校验）三个有明文出处的子目录 | 无。若落地，验收口径为 `ce-ee-engineering-standards.md` §11 |
| **readiness 与发布证据**（2026-09-22 裁定降级为**优化项**） | readiness 端点、备份点、失败回滚、不可逆迁移补偿证据；现状 `/health` 只表达进程存活。§10.6.5、§10.7.3 与 §6.2 规则 5 已同步收窄，登记见 `ce-ee-engineering-standards.md` §11 | 无。若落地，验收口径为 `ce-ee-engineering-standards.md` §11 |
| **§6.2 迁移规则「生产先备份并执行 migration preflight」**（2026-09-22 裁定整条移入**优化项**） | 备份点归 §11「readiness 与发布证据」，preflight 归 §11「deploy-preflight」；§6.2 现只保留规则 1–4 | 无。若落地，验收口径为 `ce-ee-engineering-standards.md` §11 |
| **2 个历史迁移 ID 不按 §6.3 命名**（`migrate-agent-config-model-id`、`migrate-skill-storage-by-organization`）（2026-09-22 裁定**规范豁免**） | 二者已在 `data_migrate_record` 落库，改名会被 runner 判为未应用而重跑。§6.3 已修正为「ID 落库即发布契约、已应用的迁移不改名，命名格式只约束新增迁移」，因此不计为未满足 | 无 |
| **不可变 DDL 链位于仓库根 `drizzle/` 而非 `db/migrations/`**（2026-09-22 裁定**规范对齐**） | `drizzle.config.ts` 的 `out` 与 `scripts/migrate.ts` 的 `migrationsFolder` 都显式指向 `./drizzle`；搬进 `db/` 要同步两处配置并移动 28 条已发布 SQL、snapshot、journal 与 README（含基线化命令）且无行为收益。§6.1 与目录结构 §1 已改为以仓库根 `drizzle/` 为准 | 无 |