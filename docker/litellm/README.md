# LiteLLM 模型网关（model-management 依赖）

平台的**模型网关**：Provider 凭据、Virtual Key、预算与用量的事实来源。`@fenix/model-management` 经
`RCS_MODEL_GATEWAY_BASE_URL` 调用它的管理端点（`packages/model-gateway-litellm/src/client.ts` 以
`${baseUrl}${path}` 拼 `/key/*`、`/model/*`、`/user/*`），管理员浏览器经 `RCS_MODEL_GATEWAY_ADMIN_UI_URL`
打开它的控制台。`RCS_MODEL_GATEWAY_ADMIN_KEY` 与 `RCS_MODEL_GATEWAY_CREDENTIAL_ENCRYPTION_KEY` 任一缺失时，
网关运行时整体不启用（`packages/resources/model-management/src/server/model-gateway/runtime.ts:48`），
Provider / Model 的资源 CRUD 不受影响。

本目录是**独立编排**，但**不再自足**：PostgreSQL 用 `docker/common/` 的共享实例（原先自带的 `litellm-postgres`
已删除，理由与代价见「共享 PostgreSQL」），因此**主服务项目必须先起**。数据落点也随之离开本目录：
网关库现在躺在共享实例的数据目录 `docker/common/data/postgres` 里。

## 文件与交付清单

| 文件 | 作用 |
| --- | --- |
| `docker-compose.yml` | 唯一入口：`litellm`（出口服务）+ `litellm-db-init`（一次性建库建角色） |
| `init-db.sh` | 初始化服务的逻辑本体，由 compose 以 `./init-db.sh:/init/init-db.sh:ro` 只读挂载、`sh` 解释执行（不依赖可执行位）。**属部署面**：独立部署时要随本目录一起交付，缺它初始化服务起不来 |
| `.env.example` | 本目录私有键的模板；共享键在主服务 env，不在这里重复（见「配置」） |
| `README.md` | 本文件 |

**独立部署**（网关在别的机器，或不经过 `./docker/deploy.sh`）：共享实例必须在那台机器上先起（本目录不再自带
数据库），然后：

```bash
cp docker/litellm/.env.example docker/litellm/.env     # 填 LITELLM_MASTER_KEY / LITELLM_SALT_KEY
MAIN_ENV=./.env                                        # 主服务 env：dev 是仓库根 .env，生产改成 docker/main/.env
docker compose --env-file docker/litellm/.env --env-file "$MAIN_ENV" \
  -f docker/litellm/docker-compose.yml up -d
```

指定 `--env-file` 后 compose **不再**自动读项目目录的 `.env`，所以两份都要列；**后一份优先**，主服务 env
因此放最后（共享键 `LITELLM_DB_PASSWORD` / `POSTGRES_PASSWORD` 在那里；dev 是仓库根 `.env`、生产是
`docker/main/.env`）。随主服务启动时这些键由 `./docker/deploy.sh` 从主服务 env 导出，不需要手写这一段。

## 前置条件

- Docker Engine 与 Docker Compose ≥ 2.20（本目录自己的编排不依赖 `include`，但主服务项目依赖它）。
- **共享 PostgreSQL 先就绪（本目录不再自足）**：
  ```bash
  ./docker/deploy.sh up                    # 主服务项目 + 已启用依赖；先在 docker/deploy.env 打开 FENIX_FEATURE_LITELLM
  # 或不起平台主服务、只起共享实例：
  docker compose -f docker-compose.yml up -d postgres                          # dev（仓库根编排）
  docker compose -f docker/main/docker-compose.yml up -d postgres   # 生产（自动读 docker/main/.env）
  ```
  `postgres` 是主服务项目（dev 是仓库根 `docker-compose.yml`，生产是 `docker/main/docker-compose.yml`；两份都 `include docker/common/`）的服务名。它不在时本目录的
  初始化服务会等待 360 秒后带判定退出，`litellm` 不会被拉起（见「共享 PostgreSQL」）。
- `LITELLM_MASTER_KEY` / `LITELLM_SALT_KEY` 已填（缺失即启动失败）；共享键 `LITELLM_DB_PASSWORD` 在主服务 env。
- 宿主可拉取 `ghcr.io/berriai/litellm:v1.93.0` 与 `postgres:16-alpine`（后者是初始化服务用的镜像）。
- 宿主端口：本目录只发布 `LITELLM_PORT`（默认 4000，只绑回环）；数据库端口不经过本目录。

**库与角色不用手工建**：`litellm-db-init` 是随本目录拉起的一次性服务，逻辑在 `./init-db.sh`（只读挂载、
`sh` 解释执行），它在共享实例里幂等地建 `litellm` 库与 `litellm` 角色（重跑只同步口令，不重建、不删数据），
退出码非 0 时 `litellm` 不会启动。它不需要你在宿主上执行任何 SQL。

## 配置

| 键 | 位置 | 必需性 | 说明 |
| --- | --- | --- | --- |
| `LITELLM_MASTER_KEY` | 本目录 `.env`（独立部署）/ 主服务 env（随主服务启动） | 必需 | 网关管理密钥；必须与主服务 env 的 `RCS_MODEL_GATEWAY_ADMIN_KEY` 同值 |
| `LITELLM_SALT_KEY` | 同上 | 必需 | 库内 Provider 凭据的加密盐；已有数据时填回原值，换值后旧凭据解不开 |
| `LITELLM_DB_PASSWORD` | **主服务 env**（共享键，§8.3） | 必需 | 共享 postgres 里 `litellm` 角色的口令；初始化服务建角色与 `DATABASE_URL` 都用它，必须同一个值。取值要 URL 安全（嵌进连接串），用 `openssl rand -hex 32` 生成 |
| `POSTGRES_PASSWORD` | 主服务 env（共享键） | 必需 | 共享实例超级用户 `rcs` 的口令；初始化服务用它建库建角色。与 `docker/common/docker-compose.yml` 同源 |
| `LITELLM_PORT` | 本目录 `.env` | 默认 4000 | 宿主回环端口（`127.0.0.1`），本地源码运行与管理页用 |
| `LITELLM_UI_PASSWORD` | 本目录 `.env` | 默认 `admin`（compose 内置） | 控制台口令；对回环以外暴露前必须改 |
| `RCS_MODEL_GATEWAY_BASE_URL` | 主服务 env | 启用网关时必填 | 平台访问网关的**基址**，取值见下节 |
| `RCS_MODEL_GATEWAY_ADMIN_KEY` | 主服务 env | 启用网关时必填 | = `LITELLM_MASTER_KEY` |
| `RCS_MODEL_GATEWAY_CREDENTIAL_ENCRYPTION_KEY` | 主服务 env | 启用网关时必填 | Virtual Key 的本地加密密钥（32 字节随机串，`openssl rand -hex 32`） |
| `RCS_MODEL_GATEWAY_ADMIN_UI_URL` | 主服务 env | 默认 `http://localhost:4000/ui/` | 管理员浏览器打开控制台；本编排带 root path，见下节 |
| `RCS_MODEL_GATEWAY_PUBLIC_BASE_URL` | 主服务 env | 可选 | 注入公开 Provider、供**沙盒 Agent**访问的地址；沙盒不在 `fenix-server` 网络内，要填沙盒可达的宿主地址 |
| `RCS_MODEL_GATEWAY_DEFAULT_USER_BUDGET_USD` / `RCS_MODEL_GATEWAY_DEFAULT_BUDGET_DURATION` | 主服务 env | 可选 | 首次激活用户的默认预算与周期（模块管辖） |

模型清单（Provider / Model / Key）是网关库里的运行时数据，由平台管理页维护，部署文件不持有。

## 网络接入清单

| 服务 | 接入 `fenix-server` | 理由 |
| --- | --- | --- |
| `litellm` | 是 | 出口服务：主服务容器要直连它的管理端点（契约 §3 的「依赖的对外出口服务」），它自己也要按服务名 `postgres` 访问共享实例 |
| `litellm-db-init` | 是 | 共享基础设施的消费方：按服务名 `postgres` 建库建角色，一次性退出（契约 §3 的例外条款） |

本目录没有第三个服务：原先那个不接入 ② 的辅助服务 `litellm-postgres` 已删除。共享实例的服务名 `postgres`
是全局保留名（契约 §3 规则 7）——**本目录不得再定义同名服务**：`litellm` 同时挂在项目网络与 ② 上，
两边同名时 Docker 的容器 DNS 没有优先级约定，解析可能落到本栈里那个，故障会以「连到了另一套库」的形式出现。

## 共享 PostgreSQL（`docker/common/` 的 `postgres`）

| 项 | 取值 | 依据 |
| --- | --- | --- |
| 容器内地址 | `postgres:5432` | 跨项目 DNS 名只在 `fenix-server` 上；容器内写显式值、不插值同名宿主键（§8.4） |
| 库 / 角色 | `litellm` / `litellm` | 角色是库属主、非超级用户：它能在自己库里建表（PG 15+ 起 public schema 的 CREATE 只给库属主），别的库里没有对象权限，也不是通吃全实例的角色 |
| 口令 | 主服务 env 的 `LITELLM_DB_PASSWORD` | 共享键只定义在主服务 env（§8.3）；初始化服务与 `DATABASE_URL` 同值 |
| 建库建角色 | 本目录的一次性服务 `litellm-db-init` | 共享实例只提供「实例」、不带任何栈的业务初始化（§5）：谁持有 schema 谁负责建 |
| 数据落点 | `docker/common/data/postgres` | 本目录不再有数据目录 |
| 宿主端口 | 共享实例的 `127.0.0.1:${POSTGRES_PORT:-5432}` | 本目录不发布任何数据库端口（原先自带那个也没发布，所以本次不涉及端口释放） |

**为什么收敛**：同一台机器上不必为每个栈各起一套 PostgreSQL——少一套数据目录、少一套备份对象；这也是
`docker/workflow/` 的 MySQL 上移到 `docker/common/` 的同一口径。
**代价**（必须接受）：`litellm` 与初始化服务都得接入 ② 才能按服务名寻址共享实例，因此它们也暴露在该网络里；
共享实例的可用性成为所有消费方共同的前提。

**启动顺序**：主服务项目先起。跨项目的 `depends_on` 不成立——compose 只认本项目内已定义的服务名，实测
`service "litellm-db-init" depends on undefined service "postgres": invalid compose project`（带
`required: false` 同样报错）。因此本目录用「初始化服务自己等实例就绪 → `litellm` 等初始化服务成功退出」
这条链，代替原先指向 `litellm-postgres` 的 `depends_on`。

**共享实例不可用时**：初始化服务等待 360 秒后带判定退出，`litellm` 因完成条件不满足而不会被拉起。判定：

```bash
docker compose -f docker/litellm/docker-compose.yml ps -a litellm-db-init   # Exited (1) 即失败
docker compose -f docker/litellm/docker-compose.yml logs --tail=50 litellm-db-init   # psql 原始报错 + 判定分支
docker compose -f docker-compose.yml ps postgres                            # dev（仓库根编排）；期望 healthy
docker compose -f docker/main/docker-compose.yml ps postgres   # 生产（自动读 docker/main/.env）
```

日志把两类原因分开写：`authentication` 分支指向「主服务 env 的 `POSTGRES_PASSWORD` 与实例数据目录里的口令
不一致」（口令写在数据目录里，改 `.env` 不会改库里已有的账号）；其余分支指向「实例没起 / 网络不通」。
处理：先 `./docker/deploy.sh up` 起主服务项目，再 `docker compose -f docker/litellm/docker-compose.yml up -d`。

**改了 `LITELLM_DB_PASSWORD` 之后**：把初始化服务重跑一次就够（幂等，只同步口令、不动数据）——已经成功退出的
容器可能被 `up` 直接复用而不重跑，所以要显式要求重建：

```bash
MAIN_ENV=./.env     # 主服务 env：dev 是仓库根 .env，生产改成 docker/main/.env
docker compose --env-file docker/litellm/.env --env-file "$MAIN_ENV" \
  -f docker/litellm/docker-compose.yml up -d --force-recreate litellm-db-init
```

## 容器内地址 vs 宿主地址

| 场景 | `RCS_MODEL_GATEWAY_BASE_URL` | `RCS_MODEL_GATEWAY_ADMIN_UI_URL` |
| --- | --- | --- |
| 容器形态（rcs 也在编排里） | `http://litellm:4000/litellm` | 管理员浏览器可达的地址，如 `http://<宿主或域名>:4000/litellm/ui/` |
| 本地源码运行（`bun run dev`） | `http://localhost:4000/litellm`（宿主回环口，见 `LITELLM_PORT`） | `http://localhost:4000/litellm/ui/` |
| 独立部署（网关在别的机器） | 那台机器可达的地址，同样带 `/litellm` 前缀 | 同上，换成那台机器的地址 |

两个键的区别是**给谁用**：`RCS_MODEL_GATEWAY_BASE_URL` 由平台进程访问（容器形态用服务名 `litellm`），
`RCS_MODEL_GATEWAY_ADMIN_UI_URL` 由**管理员浏览器**访问（必须是浏览器能解析的地址，不能用服务名）。

（表里的 `/litellm` 前缀来自 compose 的 `SERVER_ROOT_PATH`，依据与判定方法见下一小节；首次部署请先跑那条命令确认。）

### 待确认：`/litellm` 前缀

`SERVER_ROOT_PATH: "/litellm"` 写死在本目录 compose 里，而适配器是纯字符串拼接（`${baseUrl}${path}`，路径不含
前缀，见 `packages/model-gateway-litellm/src/client.ts` 与它 `__tests__` 里断言的 `http://litellm.test/key/generate`），
所以平台基址与浏览器 UI 地址**要么都带 `/litellm`、要么都不带**。现有证据只够指向「都带」：提交 `904aecd1b`
（`docs: 模型网关部署相关`）给当时的生产模板（`docker/prod/.env.example`，已退役）的示例把 UI 写成 `…/litellm/ui/`；但同一提交里基址又
写作 `http://litellm:4000`（不带前缀），两者只有一个是当前镜像 v1.93.0 的实际行为。**确认方法**（启动后一条命令
即可判定，200 的那个是对的）：

```bash
for u in http://127.0.0.1:4000/litellm/health http://127.0.0.1:4000/health; do
  printf '%s -> ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "$u"
done
```

## 数据与迁移

数据全部在共享实例里：`docker/common/data/postgres`（bind，相对 `docker/common/docker-compose.yml` 解析，
不属于本目录）。本目录**不再有** `./data/`，也不再需要建库建角色——那是 `litellm-db-init` 的活。

### 从旧的 `litellm-postgres` 迁过来

**A. 保留既有数据（生产升级走这条）**：在旧数据目录还在、旧容器还没删的时候做。命令都在仓库根执行，
本目录的 `up` 都带上两个 env 文件（原因见「文件与交付清单」）：

```bash
# 0) 停网关与它自带的实例
docker compose -f docker/litellm/docker-compose.yml down      # 停 litellm；新编排里已经没有 litellm-postgres 了
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -i postgres
#   ↑ 找到旧的自带实例容器（名字形如 litellm-litellm-postgres-1），docker rm -f 它：
#     它只被旧编排管理，新的 down 已经不管它；数据在 bind 目录里，删容器不删数据

# 1) 用旧数据目录起一个临时实例，导出逻辑备份（-Fc 自定义格式，含数据；容器内 local socket 免口令）
docker run --rm -d --name litellm-pg-old \
  -v "$PWD/docker/litellm/data/litellm-postgres":/var/lib/postgresql/data postgres:16-alpine
until docker exec litellm-pg-old pg_isready -U litellm -d litellm >/dev/null 2>&1; do sleep 1; done
docker exec litellm-pg-old pg_dump -U litellm -d litellm -Fc -f /tmp/litellm.dump
docker cp litellm-pg-old:/tmp/litellm.dump ./litellm.dump
docker rm -f litellm-pg-old

# 2) 起共享实例，并让初始化服务把库与角色建好（正常路径里它随 up 自动跑，这里单独跑一次好看日志）
docker compose -f docker-compose.yml up -d postgres                          # dev（仓库根编排）
docker compose -f docker/main/docker-compose.yml up -d postgres   # 生产（自动读 docker/main/.env）
MAIN_ENV=./.env   # 主服务 env：dev 是仓库根 .env，生产改成 docker/main/.env
docker compose --env-file docker/litellm/.env --env-file "$MAIN_ENV" \
  -f docker/litellm/docker-compose.yml up litellm-db-init

# 3) 把备份灌进共享实例的 litellm 库（--no-owner：对象归当前连接角色 litellm，不带入旧的属主与授权）
docker compose -f docker-compose.yml cp ./litellm.dump postgres:/tmp/litellm.dump   # dev（仓库根编排）
docker compose -f docker/main/docker-compose.yml cp ./litellm.dump postgres:/tmp/litellm.dump   # 生产（自动读 docker/main/.env）
docker compose -f docker-compose.yml exec -T postgres \
  pg_restore -U litellm -d litellm --no-owner --no-privileges /tmp/litellm.dump
docker compose -f docker/main/docker-compose.yml exec -T postgres \
  pg_restore -U litellm -d litellm --no-owner --no-privileges /tmp/litellm.dump   # 生产（自动读 docker/main/.env）
docker compose -f docker-compose.yml exec -T postgres rm -f /tmp/litellm.dump   # dev（仓库根编排）
docker compose -f docker/main/docker-compose.yml exec -T postgres rm -f /tmp/litellm.dump   # 生产（自动读 docker/main/.env）

# 4) 起网关并验收（见「验证」）
docker compose --env-file docker/litellm/.env --env-file "$MAIN_ENV" -f docker/litellm/docker-compose.yml up -d
```

口径与坑：

- **`LITELLM_SALT_KEY` 必须填回原值**：它加密库内 Provider 凭据，换值的后果与下面「两个密钥」一节相同。
- 灌数据要赶在 litellm 首次启动**之前**（它启动时会自己建表，撞上就是一堆「对象已存在」的报错）。已经起过
  就先清空该库再灌，只动 litellm 这一个库：
  ```bash
  docker compose -f docker-compose.yml exec -T postgres \
    psql -U litellm -d litellm -c 'DROP SCHEMA public CASCADE' -c 'CREATE SCHEMA public'
  docker compose -f docker/main/docker-compose.yml exec -T postgres \
    psql -U litellm -d litellm -c 'DROP SCHEMA public CASCADE' -c 'CREATE SCHEMA public'   # 生产（自动读 docker/main/.env）
  ```
- 新旧都是 PostgreSQL 16（原先是 `postgres:16-alpine`，共享实例也是 `postgres:16-alpine`），逻辑备份在这两者
  之间安全；跨大版本的物理搬迁不安全，这里不走那条路。

**B. 不迁、从零起（旧库没有要保留的数据，或本机开发）**：跳过上面第 1 步与第 3 步。库与角色由初始化服务建好，
空库启动后 litellm 自己建表；Provider / Model / Virtual Key 在管理页重新配一遍（它们是库里的运行时数据，
部署文件不持有）。旧目录原样留着，按下面的条件再删。

**旧数据目录什么时候可以删**：`docker/litellm/data/litellm-postgres` 保留到——按 A 迁完、管理页里的
Provider / Model / Virtual Key 与迁移前一致、且至少完成一次真实调用（用量页有记录）。在那之前它同时是回退
路径（换回旧编排仍读它）；删除前确认没有别的编排还挂着这个目录：

```bash
rm -rf docker/litellm/data        # 不可逆：删掉这一份就只剩共享实例里的数据
```

### 备份与恢复

数据的归属变了，备份口径跟着变（原先「备份 `./data/litellm-postgres`」作废）：

```bash
# 只备份网关库（在共享实例里导出；容器内 local socket 免口令）
docker compose -f docker-compose.yml exec -T postgres pg_dump -U litellm -Fc litellm > litellm-$(date +%Y%m%d).dump   # dev（仓库根编排）
docker compose -f docker/main/docker-compose.yml exec -T postgres pg_dump -U litellm -Fc litellm > litellm-$(date +%Y%m%d).dump   # 生产（自动读 docker/main/.env）

# 恢复（先删库里已有对象；恢复后 LITELLM_SALT_KEY 必须与备份时同值）
docker compose -f docker-compose.yml exec -T postgres pg_restore -U litellm -d litellm --clean --if-exists < litellm-YYYYmmdd.dump   # dev（仓库根编排）
docker compose -f docker/main/docker-compose.yml exec -T postgres pg_restore -U litellm -d litellm --clean --if-exists < litellm-YYYYmmdd.dump   # 生产（自动读 docker/main/.env）
```

整实例口径（连 rcs 自己的库一起）见 `docs/operations/backup-and-restore.md`：那里说的 PostgreSQL 数据目录现在
也是同一份 `docker/common/data/postgres`，网关库跟着一起走——所以备份共享实例就等于备份了网关，
「只备份网关库」这条是给按依赖粒度留档用的。

### 两个密钥由「有默认值」改为「必需」的迁移口径

改造前 compose 给的是 `LITELLM_MASTER_KEY:-litellm-master-key` / `LITELLM_SALT_KEY:-litellm-salt-key`
（见 git 历史的 `docker/litellm/docker-compose.yml` 与已退役的 `docker/prod/docker-compose.litellm.yml`）。
现在两者都改为 `${VAR:?}`：master key 必须与平台侧 `RCS_MODEL_GATEWAY_ADMIN_KEY` 同值，静默落到内置默认值只会
在调用时变成难查的 401；salt key 用于加密库内 Provider 凭据。**已有数据的部署必须把 `LITELLM_SALT_KEY` 填回
此前生效的值**（若此前从未显式设置，就是上面那个默认值），否则旧凭据解不开。

## 验证

```bash
curl -fsS http://127.0.0.1:4000/litellm/health        # 预期 200（前缀语义见「待确认」）

# 初始化服务必须成功退出（Exited (0) 才算成功；失败时日志里有原始报错与判定分支）
docker compose -f docker/litellm/docker-compose.yml ps -a litellm-db-init
docker compose -f docker/litellm/docker-compose.yml logs --tail=50 litellm-db-init

# 库与角色在共享实例里，不在本目录；两条 SELECT 各应输出一行 litellm
docker compose -f docker-compose.yml exec -T postgres \
  psql -U rcs -d postgres -tA -c "select rolname from pg_roles where rolname = 'litellm'" \
                             -c "select datname from pg_database where datname = 'litellm'"
docker compose -f docker/main/docker-compose.yml exec -T postgres \
  psql -U rcs -d postgres -tA -c "select rolname from pg_roles where rolname = 'litellm'" \
                             -c "select datname from pg_database where datname = 'litellm'"   # 生产（自动读 docker/main/.env）
# 网关的表（空库启动后由 litellm 建出；这个数 > 0 说明角色能在自己库里建对象）
docker compose -f docker-compose.yml exec -T postgres \
  psql -U litellm -d litellm -tAc 'select count(*) from pg_stat_user_tables'
docker compose -f docker/main/docker-compose.yml exec -T postgres \
  psql -U litellm -d litellm -tAc 'select count(*) from pg_stat_user_tables'   # 生产（自动读 docker/main/.env）

docker compose -f docker/litellm/docker-compose.yml ps
# 平台侧：登录控制台的系统管理页，网关卡片应显示健康；或直接看 rcs 日志里是否出现 401
```

`up -d` 与一次性服务的关系要认清：`litellm` 以 `service_completed_successfully` 依赖 `litellm-db-init`，
初始化失败时它不会被拉起；但**验收要看退出码**，`ps -a` 里的 `Exited (0)` 才是初始化成功的直接证据
（`docker/workflow/` 的 `mysql-init` 用同一套判据）。

## 升级

改本目录 `docker-compose.yml` 的 `image` 行为目标版本（固定版本，不用 `latest`、不做变量插值），然后：

```bash
cd <仓库根>
MAIN_ENV=./.env   # 主服务 env：dev 是仓库根 .env，生产改成 docker/main/.env
docker compose --env-file docker/litellm/.env --env-file "$MAIN_ENV" -f docker/litellm/docker-compose.yml pull
docker compose --env-file docker/litellm/.env --env-file "$MAIN_ENV" -f docker/litellm/docker-compose.yml up -d
```

升级不需要额外的建库步骤：`up -d` 会先把初始化服务带到「成功退出」状态（幂等，见「数据与迁移」）。
升级后核对管理页与平台的模型同步；跨大版本前先备份（口径见「备份与恢复」——网关库在共享实例里，
PostgreSQL 数据目录不能降级）。
