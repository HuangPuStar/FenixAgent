# Workflow V2 部署

Workflow V2 的部署交付物统一放在仓库 `docker/workflow/` 目录，详细说明见该目录的 `README.md`。

## 部署入口

- `docker/workflow/README.md`：交付面（镜像交付的初始化资产）、单份 `.env` 配置、启动、初始化、验收与回滚。
- `docker/workflow/docker-compose.yml`：复用固定版本上游依赖栈，部署独立 workflow-studio 服务；四个一次性服务（`assets-init` / `atlas-init` / `mysql-init` / `s3-init`）串起启动顺序。
- RCS 所需环境与共享网络配置：直接查看 `docker/workflow/docker-compose.yml` 的头部注释。
- `docker/workflow/.env.example`：唯一的环境模板（镜像 tag、宿主诊断端口、应用配置叠加层）。

## 上线前必读

1. 平台镜像不包含上游服务，必须分别交付；**上游初始化资产（`schema.sql` / Atlas HCL / ES 四件 / etcd 配置 / 画布图标）随 `workflow-studio-server` 镜像交付**，首次启动由 `assets-init` 展开到 `docker/workflow/assets/`（因此 `WORKFLOW_STUDIO_TAG` 不得低于带资产的首个发布，也不需要再 clone 上游源码）；上游画布用 `workflow-studio-web-canvas` 变体镜像交付（构建期已注入 `WORKFLOW_CANVAS_BASE=/workflow-canvas/`），不再本地构建 dist；`/workflow-canvas/<rest>` 的前缀剥离与 SPA 回退由平台静态反代与 `docker/workflow/nginx.conf` 负责。
2. 平台需完成 V2 配置与完整数据库迁移，旧工作流定义不会自动迁移为 V2。
3. 当前 code、签发白名单与撤销记录仍在平台进程内，Redis 不提供票据共享；不要直接使用无粘性的多副本路由。
4. Compose 校验通过不代表实际容器上线或画布验收通过，目标环境仍需 API、浏览器与跨租户隔离验收。

通用发布流程见 [部署](./deployment.md)、[升级](./upgrade.md) 与 [备份与恢复](./backup-and-restore.md)。
