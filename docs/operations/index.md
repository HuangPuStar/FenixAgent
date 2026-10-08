# 运维文档

本目录收纳 FenixAgent 的部署、升级、迁移、备份与排障入口。所有内容以仓库当前代码与编排为事实来源：命令、路径、环境变量、启动顺序都能在给出的文件里核对到；没有落在代码里的流程不写。

| 文档 | 用途 |
| --- | --- |
| [部署](./deployment.md) | 依赖服务、必需环境变量、环境文件从哪来，以及本地 / 单机 / 生产三种形态的真实启动顺序与启动后自检。 |
| [升级](./upgrade.md) | 镜像与代码升级步骤，DDL 迁移与数据迁移的先后关系与失败判定，以及可回滚与不可回滚的边界。 |
| [迁移](./migration.md) | `db:generate` / `db:migrate` / 数据迁移入口的实际命令与前置条件，以及本仓已有的不可逆迁移案例。 |
| [备份与恢复](./backup-and-restore.md) | 需要备份的对象与它们的真实落点、恢复顺序，以及本仓当前还没有备份脚本时的人工口径。 |
| [排障](./troubleshooting.md) | 已记录的真实坑：症状 → 定位命令 → 处置。 |

相关文档（不在此目录复述）：

- 编排与可选集成的细节：`docker/prod/README.md`
- DDL 迁移链异常的处置场景（生产冲突、迁移记录异常、历史 `db:push` 库基线化）：`drizzle/README.md`
- 当前真实架构与模块边界：`docs/arch/`；长期架构目标与发布证据要求：`docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md`
- 工程约定与门禁：`CLAUDE.md`、`docs/developer/guide/backend-development.md`
