# 交付面部署与历史部署迁移

本目录是生产交付面：`./docker/deploy.sh` 与它操作的主服务编排 `docker/main/docker-compose.yml`。本文面向两类操作：

1. 把历史部署迁移到本套部署；
2. 本套部署在测试 / 生产环境中的已知注意事项。

编排结构、env 规范与脚本细节以 [`docs/operations/docker-topology.md`](../docs/operations/docker-topology.md) 为准；升级与迁移语义见 [`docs/operations/upgrade.md`](../docs/operations/upgrade.md)、[`docs/operations/migration.md`](../docs/operations/migration.md)。

## 1. 迁移总流程

先在仓库里导出交付面，后续所有命令都在交付面里执行：

```bash
./docker/deploy.sh export /opt/fenix   # 产出 /opt/fenix/docker
cd /opt/fenix/docker
./deploy.sh init                       # 生成 deploy.env、main/.env 与各依赖 .env
```

历史部署的目录结构、数据落点、依赖组合可能各不相同，本文不预设具体路径与同步范围。迁移前先核对旧容器的真实挂载与卷：

```bash
docker inspect <旧容器名> --format '{{json .Mounts}}' | jq
docker volume ls
```

确认后再按下面的顺序实施：

1. **备份旧环境**：保留旧目录、数据库 dump 与旧编排文件；回滚依赖它们。
2. **拉取新镜像**：旧服务不停，先按 `deploy.env` 中打开的开关把对应镜像拉到目标机。
3. **首次 rsync**：把旧数据同步到交付面，允许不一致，只为减少停机窗口。
4. **逐个停止旧服务**：先停写数据的业务服务，旧数据库最后停。
5. **增量 rsync**：旧服务停写后再同步一次，补齐首次同步之后新增的数据。
6. **迁移数据库**：数据量少先 `pg_dump` / `pg_restore`；数据量大且 PostgreSQL 大版本一致时，可在停库后同步数据目录。
7. **迁移配置**：按第 2 节逐条核对旧配置，确认无遗漏后再启动。
8. **在交付面启动**：`./deploy.sh validate` → `./deploy.sh deploy`，由脚本完成 DDL 迁移、数据迁移与启动。
9. **验证**：按第 4 节检查，确认无误后再清理旧目录与旧数据。

原则：

1. 数据同步用 `rsync`，不要用 `cp -r`。`rsync` 支持增量、保留属主 / 权限 / 硬链接。
2. 不要给同步命令加 `--delete`，目标目录不是镜像，误删无法恢复。
3. 数据库是否用 dump、是否原样同步文件，取决于数据量与旧库的大版本 / 停机状态，按实际情况决定。
4. 旧数据目录同步后若属主变化，按目标容器的运行用户修正；例如 rustfs 需要 `10001:10001`。

## 2. 配置迁移

配置迁移要逐条核对，不能整份覆盖，也不能凭记忆补键。旧配置来源至少包括：旧 `.env` 文件、旧编排文件里 `environment:` 直接写死的值、各依赖自己的 env 文件。只看 `.env` 会漏掉编排里的硬编码值。

### 2.1 配置面的去向

1. **旧配置的取值**：原样迁入 `docker/main/.env`；旧环境本来就有独立依赖 env 文件的，迁入对应 `docker/<name>/.env`。
2. **新部署的开关**：`docker/deploy.env` 不是旧配置的迁移目标。它只描述新部署启用哪些依赖、使用哪些端口：按旧环境实际运行过的能力设置 `FENIX_FEATURE_*`，按实际需要设置 `FENIX_HTTP_PORT` / `POSTGRES_PORT`；端口没有特殊要求时不必写，走默认值。
3. 旧键在新模板中不存在时，先确认它确实已废弃，再决定不迁移；不要因为“新模板没有”就默认丢弃。

### 2.2 不要随意改配置，尤其是密钥

1. 迁移不是修改配置的时机，旧配置尽量原样保留，尤其是密钥类。
2. 密钥变更可能导致已保存的敏感配置无法解密、节点注册或站点发布认证失败、已下发的 token 失效；如无必要不要改。
3. 原样同步数据库数据目录时，数据库口令必须与旧值一致。
4. 地址类配置只在部署地址确实变化时修改。
5. 旧环境启用了哪些可选能力，新环境就要打开对应的 `FENIX_FEATURE_*`；漏开关不会报错，只会让能力静默缺失。
6. 需要轮换密钥时，等迁移验证通过后单独执行，不要与迁移混在一起。

### 2.3 配置验证

1. `./deploy.sh validate` 通过，必填项无遗漏。
2. 启动后检查日志中没有缺失或非法的配置项。
3. 登录、模型调用、沙盒注册、Agent Sites 发布等依赖密钥的路径逐项验证。

## 3. 部署建议与已知问题

### 3.1 OpenSandbox 建议独立部署

大多数情况下，沙盒机使用 `docker/opensandbox-cluster/deploy/` 这套独立部署单元，运维更简单：

1. 该单元在一台机器上同时起 Cluster、frps 与 Server，自建 `opensandbox` 网络，不依赖平台侧先创建 `fenix-server`。
2. 平台机保持 `FENIX_FEATURE_OPENSANDBOX_CLUSTER=false`、`FENIX_FEATURE_OPENSANDBOX_SERVER=false`，不要两套同时起，否则会抢端口。
3. 按 [`docker/opensandbox-cluster/deploy/fenix-integration.md`](opensandbox-cluster/deploy/fenix-integration.md) 准备配置并启动。
4. 平台侧配置 `RCS_SANDBOX_CLUSTER_URL`、`RCS_SANDBOX_CLUSTER_API_KEY` 与默认沙盒参数。

随主服务启动的 `FENIX_FEATURE_OPENSANDBOX_*` 不作为推荐路径：它把沙盒管理面与平台生命周期绑在一起，运维复杂度更高。OpenSandbox 统一按上述独立部署单元维护。

### 3.2 `FENIX_HTTP_PORT` / `POSTGRES_PORT` 要同时写进 `docker/main/.env`

这两个键是 Compose 的插值变量，不是容器内配置：

1. 走 `deploy.sh` 时，脚本会加载 `docker/deploy.env` 和 `docker/main/.env`，只写在 `deploy.env` 里也能启动。
2. 单独重启主服务（`cd docker/main && docker compose up -d`）时，Compose 只读同目录的 `docker/main/.env`。键不在那里，端口会回落到默认的 `3001` / `5432`。
3. 因此 `init` 之后，把这两个键同时写到 `docker/main/.env` 头部，取值与 `docker/deploy.env` 保持一致。
4. 两份都写时，`deploy.sh` 以 `docker/main/.env` 的值为准，因为它是后加载的；不要让两处出现不同值。

### 3.3 迁移期间的其他注意事项

1. 旧项目与新项目可能同名或占用固定容器名 / 端口。启动新环境前先停旧项目，确认端口已释放。
2. 迁移期间不要执行 `./deploy.sh down --purge-data`；它会删除 `docker/main/` 下的数据目录。
3. `deploy.sh deploy` 会先跑 DDL 迁移与数据迁移。迁移一旦执行，回滚到旧版本不再保证可行，回滚窗口在 `deploy.sh deploy` 之前。
4. 旧容器只 `stop`，确认新环境验证通过后再 `down`，不要提前删除旧数据。

## 4. 迁移后验证

1. `./deploy.sh ps`：主服务与已启用依赖全部为 healthy。
2. `curl -fsS "http://127.0.0.1:<FENIX_HTTP_PORT>/health"`：返回 `status: ok`，`commitId` 与预期镜像一致。
3. 控制台可登录，组织、用户与 Agent 列表正常。
4. 历史会话与消息记录完整。
5. 启用工作流 / 知识库 / 沙盒时，对应能力可正常使用。
6. `./deploy.sh logs rcs` 无持续报错。

全部通过后再清理旧目录与旧数据。
