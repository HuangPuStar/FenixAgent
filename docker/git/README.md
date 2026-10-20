# Forgejo（公共 Git / 工单依赖）

平台的**公共 Git 服务**：仓库、Issue、评论与标签的事实源，`@fenix/git` 与工单模块经它读写（工单不直接连它）。
AOS 侧入口是主服务 env 的 `AOS_GIT_CONFIG_FILE` 指向的连接配置——`baseUrl` 容器形态填 `http://forgejo:3000`、
本地源码运行填 `http://127.0.0.1:3210`；探活用 `AOS_GIT_FORGEJO_URL`（`/api/healthz`）。Forgejo 不可达只降级
Git 与工单能力，不阻断 AOS 启动。

`FENIX_FEATURE_GIT` 只管**这一个共享服务**的部署：工单是否启用由 assembly 决定，关工单不等于可以停 Forgejo。
接入已有 Forgejo（别的机器或既有实例）时**不启动本目录**，见「接入已有 Forgejo」。

## 前置条件

- Docker Compose ≥ 2.20；`fenix-server` 网络已存在（由主服务项目创建，见 `docs/operations/docker-topology.md`）。
- 共享 `postgres`（`docker/common/`）已起，并按下一节建好库与角色。
- `./data/` 可写。镜像以容器内 `git` 用户运行，启动脚本会自行 chown `/data/gitea`、`/data/git`，通常无需宿主手工处理。

## 共享 PostgreSQL（显式初始化，启动前做）

Forgejo 的库与角色不由共享实例的初始化脚本创建：共享实例往往早已初始化，`docker-entrypoint-initdb.d` 那时不再执行。
库必须在 Forgejo 首次启动前存在（建表与迁移由它自己跑）；库名 / 角色名 / 口令要与 `.env` 的 `FORGEJO_DB_NAME` / `FORGEJO_DB_USER` / `FORGEJO_DB_PASSWORD` 一致：

```bash
docker run --rm -it --network fenix-server postgres:16-alpine psql -h postgres -U rcs -d postgres
```

```sql
CREATE ROLE forgejo LOGIN PASSWORD '<与 FORGEJO_DB_PASSWORD 同值>';
CREATE DATABASE forgejo OWNER forgejo ENCODING 'UTF8';
-- 口令不一致时用下面这条交互式重设（不写进 SQL 与 shell 历史），新口令与 .env 同值
\password forgejo
```

重跑报 `already exists` 即跳过；`.env` 与库里的口令不一致时用 `\password forgejo` 把库里改成一致的那个。

## 启动

```bash
cp docker/git/.env.example docker/git/.env      # 填 FORGEJO_DB_PASSWORD
docker compose -f docker/git/docker-compose.yml up -d
curl -fsS http://127.0.0.1:3210/api/healthz     # 预期 200 OK（端口以 FORGEJO_HOST_PORT 为准）
docker compose -f docker/git/docker-compose.yml ps   # 状态应为 healthy
```

库不可达时容器会反复重启，日志里是 `InitDBEngine` 的连接失败重试——先核对 `.env` 与库里的一致，再排网络。
随主服务一键启动：`docker/deploy.env` 里 `FENIX_FEATURE_GIT=true`，再由 `./docker/deploy.sh up` 拉起（先起主服务项目）。

## 首次初始化（顺序）

1. 建库与角色（上一节）→ 2. `up -d` 起 Forgejo → 3. 建首个管理员（`INSTALL_LOCK` 已开，网页安装向导不会出现）：

```bash
set -a; . docker/git/.env; set +a        # 读入 FORGEJO_ADMIN_*（也可把值直接写进命令）
docker exec -u git fenix-forgejo forgejo -c /data/gitea/conf/app.ini admin user create \
  --username "$FORGEJO_ADMIN_USERNAME" --password "$FORGEJO_ADMIN_PASSWORD" \
  --email "$FORGEJO_ADMIN_EMAIL" --admin --must-change-password=false
```

重跑报 `user already exists` 视为已完成。4. 在 Forgejo 里建 AOS 用的服务账号与访问令牌（按最小权限），把 `baseUrl` 与令牌引用写进 `AOS_GIT_CONFIG_FILE` 指向的连接配置。
5. 显式 bootstrap：`bun run scripts/git-bootstrap.ts`（**尚未实现**，随 T07 交付：建仓库 / Webhook / 权限）；在此之前手工建仓库即可继续。

## 端口与卷

| 项 | 宿主 | 容器 | 说明 |
| --- | --- | --- | --- |
| HTTP API | `127.0.0.1:${FORGEJO_HOST_PORT:-3210}` | `3000` | 容器之间走 `fenix-server` 上的服务名 `forgejo:3000`；SSH(22) 不发布，需要时自行加端口映射 |
| 数据 | `./data/forgejo` | `/data` | 仓库、附件、LFS、avatar、`app.ini`（`/data/gitea/conf/`）与自动生成的 `SECRET_KEY` 都在这里 |
| 配置 | `./data/forgejo-config` | `/etc/forgejo` | 15.0.9 镜像不写该路径（app.ini 在 `/data` 卷内），保留挂载是为 rootless 或后续镜像版本改用该路径 |

两个目录都是 bind 挂载（相对本文件解析，`./data/` 不进版本控制），备份与搬迁随本目录整体进行；重建容器不会丢配置。

## 接入已有 Forgejo

本目录保持关闭（`FENIX_FEATURE_GIT=false`），只配主服务的 `AOS_GIT_CONFIG_FILE`：`baseUrl` 指向那台实例、
令牌用 `{env:...}` 引用环境密钥，`AOS_GIT_FORGEJO_URL` 同步改成探活地址——本目录文件留着不影响运行。

## 升级

改 `docker-compose.yml` 的 `image` 行（固定版本与 digest，禁止 `latest`，digest 随 T00 的真实拉取固定），再
`pull` + `up -d`。升级前停容器并备份 `./data/forgejo`（库在共享实例里，另用 `pg_dump` 备份）；跨大版本（15→16）
按上游升级说明先验证。
