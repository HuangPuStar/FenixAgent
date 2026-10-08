# npm 私有源（Verdaccio，plugin-market 依赖）

插件市场（`packages/resources/plugin-market`）的元数据来源：Verdaccio 提供 npm 私有源，市场从它读 packument、做预览与发布。

市场的元数据来自**外部 npm 私有源**，本仓只读不写（不下载、不解压 tarball）；本地开发要真跑通「预览 / 发布」就需要一个可写的源，
本目录只负责这一个依赖。未配置或未启动时只有发布与预览路径失败（`REGISTRY_NOT_CONFIGURED`，503），
浏览已发布的插件走本地快照，不受影响——市场把它声明为 `required: false`。

## 拓扑

```text
external 网络 fenix-server（顶层项目创建）：
    rcs（容器形态）──→ npm-registry:4873        ← 本栈唯一服务，主服务的访问入口

宿主（只绑回环）：
    127.0.0.1:4873 ←── 主服务跑源码（bun run dev）/ npm CLI / 运维

数据：./data/verdaccio ←→ 容器内 /verdaccio/storage
      （已发布的包、上游缓存与用户库 htpasswd 都在这里）
```

只有 `npm-registry` 一个服务，没有栈内辅助服务，所以它同时是「唯一出口」与「全部内容」。

## 前置条件

- Docker Engine 与 Docker Compose v2。
- **顶层项目已启动**：`fenix-server` 由顶层（仓库根 `docker-compose.yml`）创建，本目录只以 `external: true` 引用；
  单独跑本目录前先 `./docker/deploy.sh up`（或至少起来顶层项目），否则 `up` 会因为找不到该网络而失败。
- 宿主端口 4873 空闲。本目录没有 env 键，端口是 compose 里的字面量，改它等于改编排（见「配置」）。
- 首次 `npm adduser` 会在存储目录里建 `htpasswd`（凭据就存在那里）；存储目录由 Docker 在首次 `up` 时创建。

## 地址：两种运行形态

| 主服务形态 | `PLUGIN_MARKET_REGISTRY_URL` | 说明 |
| --- | --- | --- |
| 容器（`./docker/deploy.sh up`） | `http://npm-registry:4873` | 走共享网络的服务名；容器内的 `localhost` 不是宿主 |
| 源码（`bun run dev` / `restart-server.sh`） | `http://127.0.0.1:4873` | 走本目录发布的回环端口 |

两者填**不带尾斜杠**的 base URL：市场的探活路径是 `<PLUGIN_MARKET_REGISTRY_URL>/-/ping`（与本编排 healthcheck 同一端点，
避免「自检通过、容器 unhealthy」的分裂口径）。

## 配置

本目录**没有** `.env.example`，因为它没有私有键。理由：`docker-compose.yml` 里没有任何 `${VAR...}` 插值——
镜像 tag、容器名、回环端口、数据路径都是写死的字面量，可配置项只有 Verdaccio 自己的配置文件（本编排不挂自定义
`config.yaml`，用的是镜像内置默认值）。因此「`init` 生成 `.env`」这一步对本目录是空操作（脚本对缺失的模板静默跳过）。

应用侧（主服务读）的键都在仓库根 `.env`，按 §8.3「共享键只在根 `.env` 定义」不在这里重复：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `PLUGIN_MARKET_REGISTRY_URL` | 未设置即不生效 | 私有源 base URL：容器形态 `http://npm-registry:4873`，源码形态 `http://127.0.0.1:4873` |
| `PLUGIN_MARKET_REGISTRY_TOKEN` | 未设置即不生效 | Bearer 凭据，密钥；只在把读取收紧到 `$authenticated` 时才必需（见「认证」） |
| `PLUGIN_MARKET_REGISTRY_TIMEOUT_MS` | `8000` | 单次请求超时（毫秒）；超时对调用方表现为 `REGISTRY_UNAVAILABLE` |
| `PLUGIN_MARKET_REGISTRY_MAX_BYTES` | `4194304` | 响应字节上限（4 MiB）；超限拒绝而不截断 |

真相来源：`packages/resources/plugin-market/fenix.module.ts` 的 `envDefinitions`。

## 网络接入清单

| 服务 | 接入 `fenix-server` | 理由 |
| --- | --- | --- |
| `npm-registry` | 是 | 主服务容器要直连它（`http://npm-registry:4873`），它也是本目录唯一的服务；宿主回环端口只服务源码运行与 npm CLI |

核对方式：

```bash
docker network inspect fenix-server --format '{{range .Containers}}{{.Name}} {{end}}'
# 期望出现 fenix-npm-registry（容器名固定，见 compose 的 container_name）
```

## 认证与凭据

Verdaccio 默认配置下**读取匿名开放**（`access: $all`）、**发布需要认证**。所以市场不配 token 也能读；
token 只在把读取收紧到 `$authenticated` 时才必需。

试发布一个带 `mcpp` 字段的测试包：

```bash
npm adduser --registry http://127.0.0.1:4873    # 首次，用户在存储目录的 htpasswd 里
npm publish  --registry http://127.0.0.1:4873   # 包的 package.json 需带 mcpp 字段
```

本地开发账号是 `fenix-dev` / `fenix-dev`——它只服务这个回环绑定的 dev 源。取 token（首次调用即创建用户并返回 token）：

```bash
curl -X PUT http://127.0.0.1:4873/-/user/org.couchdb.user:fenix-dev \
  -H 'content-type: application/json' -d '{"name":"fenix-dev","password":"fenix-dev"}'
```

该 token **不是 JWT、不带过期时间**：它是 `base64(签名密钥对)`，与用户一起存在 `./data/verdaccio` 里，
删掉该用户（或清空该目录）才会失效。取到后凭 `~/.npmrc` 找到它（`//127.0.0.1:4873/:_authToken=…`），
写进根 `.env` 的 `PLUGIN_MARKET_REGISTRY_TOKEN`，市场即以 `authorization: Bearer …` 读取。

**不要把端口开到公网**：它只绑回环、只服务本地开发。需要跨机访问时应让对端经 `fenix-server` 或反代访问，
不要把 compose 里的端口行改成 `4873:4873`（那会把一个已知口令、无过期 token 的源暴露给同网段）。

## 数据与迁移

数据是 bind 挂载（`./data/verdaccio` → `/verdaccio/storage`），随本目录一起打包搬迁，`docker volume ls` 里不再有
属于它的卷。该目录被根 `.gitignore` 的 `data` 规则忽略。

**从旧的命名卷 `npm-registry-storage` 迁移**（在此之前已发布过包才需要）：

```bash
# 1. 停容器（down 不删卷，数据仍在旧卷里）
docker compose -f docker/npm-registry/docker-compose.yml down

# 2. 找到旧卷的真实名字（命令行里写的是卷的逻辑名，实际名字带项目前缀）
docker volume ls --filter name=npm-registry-storage

# 3. 把旧卷内容整份搬到本目录（下面用任意带 sh 的镜像；没有就先 pull 一次）
mkdir -p docker/npm-registry/data/verdaccio
docker run --rm \
  -v <上一步的卷名>:/from:ro \
  -v "$PWD/docker/npm-registry/data/verdaccio":/to \
  alpine:3.20 sh -c 'cp -a /from/. /to/ && ls -la /to'
```

搬完再起容器并核对：

```bash
docker compose -f docker/npm-registry/docker-compose.yml up -d
docker compose -f docker/npm-registry/docker-compose.yml logs npm-registry   # 有 EACCES / EPERM 见下
curl -fsS http://127.0.0.1:4873/-/ping
npm view <你之前发布过的包名> --registry http://127.0.0.1:4873
```

- **属主问题**：从卷里 `cp -a` 出来的文件保留原来的 uid/gid（通常是 root）。若 Verdaccio 在容器里以非 root 用户运行，
  它会写不进去。确认容器内身份并修正宿主目录属主（uid 以实测为准）：
  ```bash
  docker compose -f docker/npm-registry/docker-compose.yml exec npm-registry id
  sudo chown -R <uid>:<gid> docker/npm-registry/data/verdaccio
  ```
- **确认迁移成功、且不再需要旧卷后**，才删除旧卷：`docker volume rm <卷名>`（破坏性操作，删前先确认上面的包能读到）。

## 验证

```bash
# 1. 配置解析（不启动任何容器）
docker compose -f docker/npm-registry/docker-compose.yml config

# 2. 起栈（顶层必须先起）
docker compose -f docker/npm-registry/docker-compose.yml up -d
docker compose -f docker/npm-registry/docker-compose.yml ps        # 期望 fenix-npm-registry 为 running / healthy

# 3. 宿主回环端口（healthcheck 用的是同一个端点）
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4873/-/ping    # 期望 200
npm ping --registry http://127.0.0.1:4873                                  # 期望 PONG

# 4. 共享网络成员
docker network inspect fenix-server --format '{{range .Containers}}{{.Name}} {{end}}'   # 应含 fenix-npm-registry
```

容器形态下的端到端连通以主服务侧为准：`PLUGIN_MARKET_REGISTRY_URL=http://npm-registry:4873` 后，在市场页面做一次
「发布 / 预览」；浏览既有插件不经过私有源，通不了不代表市场不可用。

## 升级

改 `docker-compose.yml` 的 `image:` 行（当前 `verdaccio/verdaccio:6`：锁大版本、不用 `latest`、不做插值）后：

```bash
docker compose -f docker/npm-registry/docker-compose.yml up -d
```

`verdaccio/verdaccio:6` 会跟随 6.x 补丁版本更新，要精确定版就把 tag 收敛成具体补丁号或 digest：拉取后
`docker image inspect verdaccio/verdaccio:6 --format '{{index .RepoDigests 0}}'` 取到值，写成 `image: verdaccio/verdaccio:6@sha256:…`。

升级前备份 `./data/verdaccio`：存储布局的跨版本兼容性以 Verdaccio 的发布说明为准；不确定时先在数据副本上起新 tag 验证，
确认能读出既有包再替换生产目录。回滚同理——把 `image:` 行改回旧 tag 并 `up -d`。
