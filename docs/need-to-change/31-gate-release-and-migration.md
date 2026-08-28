# 31. 发布必须消费同一套 CI 证据，迁移未知失败必须阻断启动

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高；Drizzle 跨副本锁能力仍需实验 |
| 影响 | 测试失败提交被发镜像、生产构建问题 merge 后才发现、部分 schema 启动、并发数据迁移 |

## 对抗判决

Docker publish 在 main/tag push 上独立运行，不依赖 CI；PR CI 不构建 web/Docker/docs、不演练 migration/e2e。migration runner 对任何 message 含 `already exists` 的异常都退出成功。应用启动又会在每个副本执行包含文件副作用的数据迁移，没有 claim/lock 状态。

## 已核验证据

- `.github/workflows/docker-publish.yml:3-58`：直接 build/push，无可追溯 CI gate。
- `.github/workflows/ci.yml:13-61`：仅 format/lint/typecheck、backend/package/frontend test；无 production web、Docker、docs、migration、e2e。
- `.gitmodules:1-3`：e2e URL 是本机绝对路径 `/tmp/fenix-e2e`，CI 不可克隆且 workflow 未运行它。
- `scripts/migrate.ts:10-21`：整个 `migrate()` 任意 `already exists` 异常被判成功。
- `docker-compose.prod.yml:47-48`：每个 app 容器启动前运行 migration。
- `src/services/data-migrate.ts:37-47`、`src/index.ts:77-79`：每个进程先做副作用后插完成记录，无 running claim/owner。
- `migrate-skill-storage-by-organization.ts:57-100`：数据迁移包含文件复制、归档、删除，重复并发不是纯 DB no-op。

## 架构诊断

CI、artifact build、schema migration、data migration 和 deploy 是五套各自触发的流程，没有一个 Release Evidence Module/manifest 证明“这个 digest 通过了什么”。迁移的 interface 只有 exit code，runner 又把未知失败改写成成功。

## 目标不变量

- PR 必须通过 non-mutating format/lint/typecheck、全部测试、`build:web`、docs build、镜像 build/smoke、migration rehearsal 和关键 e2e。
- 发布只推广已通过上述 gate 的同一 immutable digest；tag/main 不重新构建不同内容。
- DDL 只根据 migration journal 判断已应用；除显式、一次性的 baseline 命令外，任何未知错误失败退出。
- migration 作为独立单执行者 Job；应用 readiness 校验目标 schema 版本，不自行并发跑 DDL。
- 数据迁移有 durable claim（running/succeeded/failed、owner、attempt）、锁、幂等步骤和恢复/补偿。
- 产出 SBOM、provenance、commit/schema/build metadata，并与 image digest 绑定。

## 分阶段整改

1. 移除 `already exists` 吞错；把历史 db:push 转显式运维 baseline。
2. 修 e2e 来源并在 PR 加 web/docs/image/migration smoke。
3. 发布 workflow 改为复用 CI artifact/digest；main/tag 只做 promotion。
4. 将 data migration 改为可 claim 的状态机，覆盖进程崩溃/双副本。

## 验收与观测

- 注入部分 DDL、重复对象、错误 constraint、双 migration 进程时，只有确定安全路径成功；未知状态阻断 readiness。
- 测试失败的 commit 不能生成可部署 tag；生产 digest 可反查完整 gate 结果。
- 指标包含 schema version mismatch、migration owner/age/retry、release gate/digest 和 rollback outcome。

## 误报排除

Docker build 自身运行 `build:web`，因此构建失败的镜像通常不会 push；已确认风险是测试失败但可构建的提交仍发布，以及生产构建失败只在 merge 后暴露。Drizzle 是否已有足够跨副本锁需专项实验，不在此无证据断言。
