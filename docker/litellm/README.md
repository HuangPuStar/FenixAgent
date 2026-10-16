# LiteLLM 模型网关（model-management 依赖）

平台的**模型网关**：Provider 凭据、Virtual Key、预算与用量的事实来源。`@fenix/model-management` 经
`RCS_MODEL_GATEWAY_BASE_URL` 调用它的管理端点（`packages/model-gateway-litellm/src/client.ts` 以
`${baseUrl}${path}` 拼 `/key/*`、`/model/*`、`/user/*`），管理员浏览器经 `RCS_MODEL_GATEWAY_ADMIN_UI_URL`
打开它的控制台。`RCS_MODEL_GATEWAY_ADMIN_KEY` 与 `RCS_MODEL_GATEWAY_CREDENTIAL_ENCRYPTION_KEY` 任一缺失时，
网关运行时整体不启用（`packages/resources/model-management/src/server/model-gateway/runtime.ts:48`），
Provider / Model 的资源 CRUD 不受影响。

本目录是**独立编排**，且**自带依赖实例**：PostgreSQL 由栈内 `litellm-postgres` 提供——库 `litellm` 与角色
`litellm` 由镜像的 `POSTGRES_USER` / `POSTGRES_DB` 在数据目录初始化时建好，数据落本目录 `./data/postgres`
（口径见「本目录自带的 PostgreSQL」）。共享实例时代的 `docker/common/` 已删除，本目录不再读任何跨项目共享键；
剩下唯一的跨项目约束是网络：它仍以 `external: true` 引用 `fenix-server`，因此**主服务项目必须先起**。

## 文件与交付清单

| 文件 | 作用 |
| --- | --- |
| `docker-compose.yml` | 唯一入口：`litellm`（出口服务）+ `litellm-postgres`（栈内数据库实例） |
| `.env.example` | 本目录全部部署键的模板（含 `LITELLM_DB_PASSWORD`）；已无共享键（见「配置」） |
| `README.md` | 本文件 |

**独立部署**（网关在别的机器，或不经过 `./docker/deploy.sh`）：数据库就在本目录的编排里，不需要先准备任何共享实例，
只要求那台机器上已有 `fenix-server` 网络（即主服务项目已起）：

```bash
cp docker/litellm/.env.example docker/litellm/.env     # 填 LITELLM_MASTER_KEY / LITELLM_SALT_KEY / LITELLM_DB_PASSWORD
docker compose -f docker/litellm/docker-compose.yml up -d
```

compose 的项目目录就是本目录，插值只读同目录 `.env`，不需要 `--env-file`，也不读主服务 env。唯一的跨文件约定是
`LITELLM_MASTER_KEY` 必须与主服务 env 的 `RCS_MODEL_GATEWAY_ADMIN_KEY` 同值：随主服务启动时由
`./docker/deploy.sh` 从主服务 env 导出（两处同值、零人工同步），独立部署时自己把这两处对齐。

## 前置条件

- Docker Engine 与 Docker Compose v2；随主服务启动时 `./docker/deploy.sh` 要求 **≥ 2.20.0**（它用到服务 profile 与
  `depends_on` 健康条件）。本目录自己的编排不带 `include`、不用 profile，启动顺序只用 `depends_on: service_healthy`。
- **主服务项目已启动**：`fenix-server` 由主服务项目创建（dev 是仓库根 `docker-compose.yml`，生产是
  `docker/main/docker-compose.yml`），本目录的编排只以 `external: true` 引用它。单独跑本目录前先起主服务项目，
  否则 `up` 会报 `network fenix-server declared as external, but could not be found`。
- `LITELLM_MASTER_KEY` / `LITELLM_SALT_KEY` / `LITELLM_DB_PASSWORD` 都在本目录 `.env` 里填（三者缺失即启动失败）。
- 宿主可拉取 `ghcr.io/berriai/litellm:v1.93.0` 与 `postgres:16-alpine`（后者是栈内 `litellm-postgres` 用的镜像）。
- 宿主端口：本目录只发布 `LITELLM_PORT`（默认 4000，只绑回环）；`litellm-postgres` 不发布任何宿主端口。

**库与角色不用手工建，也没有一次性初始化服务**：库 `litellm` 与角色 `litellm` 由 `litellm-postgres` 镜像的
`POSTGRES_USER` / `POSTGRES_DB` 在数据目录初始化时直接建好（原先的 `litellm-db-init` 与 `init-db.sh` 已删除），
`litellm` 用 `service_healthy` 等实例就绪再启动。整个过程不需要你在宿主上执行任何 SQL。

## 配置

| 键 | 位置 | 必需性 | 说明 |
| --- | --- | --- | --- |
| `LITELLM_MASTER_KEY` | 本目录 `.env` | 必需 | 网关管理密钥；必须与主服务 env 的 `RCS_MODEL_GATEWAY_ADMIN_KEY` 同值（随主服务启动时由 `deploy.sh` 导出主服务 env 带入） |
| `LITELLM_SALT_KEY` | 本目录 `.env` | 必需 | 库内 Provider 凭据的加密盐；已有数据时填回原值，换值后旧凭据解不开 |
| `LITELLM_DB_PASSWORD` | 本目录 `.env` | 必需 | 栈内 `litellm-postgres` 里 `litellm` 角色的口令：实例的 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 两处同值，取值要 URL 安全（嵌进连接串），用 `openssl rand -hex 32` 生成。改动只在数据目录为空时写入数据库（见「本目录自带的 PostgreSQL」） |
| `LITELLM_PORT` | 本目录 `.env` | 默认 4000 | 宿主回环端口（`127.0.0.1`），本地源码运行与管理页用 |
| `LITELLM_UI_PASSWORD` | 本目录 `.env` | 默认 `admin`（compose 内置） | 控制台口令；对回环以外暴露前必须改 |
| `RCS_MODEL_GATEWAY_BASE_URL` | 主服务 env | 启用网关时必填 | 平台访问网关的**基址**，取值见下节 |
| `RCS_MODEL_GATEWAY_ADMIN_KEY` | 主服务 env | 启用网关时必填 | = `LITELLM_MASTER_KEY` |
| `RCS_MODEL_GATEWAY_CREDENTIAL_ENCRYPTION_KEY` | 主服务 env | 启用网关时必填 | Virtual Key 的本地加密密钥（32 字节随机串，`openssl rand -hex 32`） |
| `RCS_MODEL_GATEWAY_ADMIN_UI_URL` | 主服务 env | 默认 `http://localhost:4000/ui/` | 管理员浏览器打开控制台；本编排带 root path，见下节 |
| `RCS_MODEL_GATEWAY_PUBLIC_BASE_URL` | 主服务 env | 可选 | 注入公开 Provider、供**沙盒 Agent**访问的地址；沙盒不在 `fenix-server` 网络内，要填沙盒可达的宿主地址 |
| `RCS_MODEL_GATEWAY_DEFAULT_USER_BUDGET_USD` / `RCS_MODEL_GATEWAY_DEFAULT_BUDGET_DURATION` | 主服务 env | 可选 | 首次激活用户的默认预算与周期（模块管辖） |

模型清单（Provider / Model / Key）是网关库里的运行时数据，由平台管理页维护，部署文件不持有。

本目录**没有共享键**：栈内实例的凭据（`LITELLM_DB_PASSWORD`）已从主服务 env 收回本目录 `.env`。主服务 env 里的
`POSTGRES_PASSWORD`（以及主服务编排插值的 `POSTGRES_PORT`）与本目录无关——那是主服务自己的 `postgres` 实例
（`docker/main/`）的口令与回环端口。

## 网络接入清单

| 服务 | 接入 `fenix-server` | 理由 |
| --- | --- | --- |
| `litellm` | 是 | 出口服务：主服务容器要直连它的管理端点（契约 §3 的「依赖的对外出口服务」） |
| `litellm-postgres` | 是 | 栈内数据库实例：只被同项目的 `litellm` 访问；它与 `litellm` 同处一个项目、没有别的栈内服务，单开一张内层网络的收益不抵复杂度 |

两个服务的名字都带 `litellm-` 前缀，**避开 `fenix-server` 上的保留名 `postgres`**（契约 §3 规则 7：`postgres`
是主服务项目自己的实例在 `fenix-server` 上的名字）。同名会造成解析歧义：容器 DNS 对同一网络上的同名服务没有
优先级约定，请求可能落到另一边，故障以「连到了另一套库」的形式出现。

## 本目录自带的 PostgreSQL

| 项 | 取值 | 依据 |
| --- | --- | --- |
| 容器内地址 | `litellm-postgres:5432` | 同项目服务名；容器内写显式值、不插值同名宿主键（§8.4），库名与角色名也写死在编排里 |
| 库 / 角色 | `litellm` / `litellm` | 由镜像的 `POSTGRES_USER` / `POSTGRES_DB` 在数据目录初始化时建好；角色是库属主、非超级用户：它能在自己库里建表（PG 15+ 起 public schema 的 CREATE 只给库属主），别的库里没有对象权限 |
| 口令 | 本目录 `.env` 的 `LITELLM_DB_PASSWORD` | 栈内实例的凭据只有本栈读写，因此不再占主服务 env 的位置；实例的 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 两处同值 |
| 建库建角色 | `litellm-postgres` 镜像初始化 | 镜像的这两个变量本身就在数据目录初始化时建库建号，不需要一次性服务 |
| 数据落点 | `./data/postgres` | bind 到本目录（契约 §13.8），随本目录交付面搬迁/备份 |
| 宿主端口 | 不发布 | 只有 `fenix-server` 网络内的 `litellm` 会连它；本地源码调试不走这个库 |

**为什么自带而不是用平台那个 `postgres`**：网关库（Provider 凭据、Virtual Key、用量）与平台库的生命周期、
备份、升级节奏都不同，共用实例会让一方的口令轮换、库空间、版本升级外溢到另一方。
**代价**（必须接受）：多一套数据目录与一份要单独备份的对象（`./data/postgres`）；本目录仍要引用 `fenix-server`
网络——那只是网络依赖，不再依赖别的项目里的实例。

**启动顺序**：`litellm` 以 `depends_on: litellm-postgres: service_healthy` 等实例就绪（`pg_isready` 通过），
依赖全在本项目内，**没有跨项目等待**——跨项目的 `depends_on` 表达不了，compose 只认本项目内已定义的服务名
（共享实例时期只能用「一次性初始化服务自己等实例」绕开，现在不需要了）。

**实例不可用时**：`litellm` 因健康条件不满足而不会被拉起。判定：

```bash
docker compose -f docker/litellm/docker-compose.yml ps litellm-postgres    # 期望 healthy
docker compose -f docker/litellm/docker-compose.yml logs --tail=50 litellm-postgres
docker compose -f docker/litellm/docker-compose.yml logs --tail=50 litellm   # 连库失败报在这里
```

健康检查只看实例是否接受连接（`pg_isready`），**口令不对时它不会失败**，所以口令漂移只能由 `litellm` 自己报出来：
日志里出现 `password authentication failed for user "litellm"` 就是 `.env` 的口令与数据目录里已有账号不一致。
处理：先 `./docker/deploy.sh up` 起主服务项目（网络不在时 `up` 直接报错），再
`docker compose -f docker/litellm/docker-compose.yml up -d`。

**改了 `LITELLM_DB_PASSWORD` 之后**：口令只在数据目录为空时写入数据库，已有数据时改 `.env` 不生效（也没有
初始化服务可以重跑）。两条路：

```bash
# 1) 改库内口令与本目录 .env 的新值一致（数据不动）
docker compose -f docker/litellm/docker-compose.yml exec -T litellm-postgres \
  psql -U litellm -d litellm -c "ALTER USER litellm WITH PASSWORD '新口令'"
# 2) 或重建数据目录 ./data/postgres（会丢数据，先备份，见「备份与恢复」）
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

数据全部在本目录：`./data/postgres`（bind，相对 `docker/litellm/docker-compose.yml` 解析）。库与角色由
`litellm-postgres` 镜像在数据目录初始化时建好，本目录没有一次性初始化服务。

### 接入既有数据

网关库的历史落点有两处，都不是本目录现在的 `./data/postgres`：共享实例时期（`docker/common/`）在
`docker/common/data/postgres` 里，与平台自己的库同一个数据目录；更早的自带实例用命名卷
`litellm-postgres-data`（compose 会加项目名前缀，实际名字形如 `litellm_litellm-postgres-data`，
`docker volume ls | grep litellm` 可确认）。两处都按逻辑备份搬——物理目录不能跨版本直接复用，共享目录里也不该
挑单个库出来。

**A. 保留既有数据（生产升级走这条）**：在旧容器 / 旧数据目录还在的时候做，命令都在仓库根执行：

```bash
# 0) 停网关（本目录的 down 只停本目录的服务，不碰旧实例容器）
docker compose -f docker/litellm/docker-compose.yml down
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -i postgres
#   ↑ 找到旧的自带实例容器（名字形如 litellm-litellm-postgres-1）就 docker rm -f 它：删容器不删数据

# 1) 用旧数据起一个临时实例，导出逻辑备份（-Fc 自定义格式，含数据；容器内 local socket 免口令）
docker run --rm -d --name litellm-pg-old \
  -v litellm_litellm-postgres-data:/var/lib/postgresql/data postgres:16-alpine
#   ↑ 命名卷（更早的自带实例）；若旧数据是共享实例时期的，改挂那个目录：
#     -v "$PWD/docker/common/data/postgres":/var/lib/postgresql/data
until docker exec litellm-pg-old pg_isready -U litellm -d litellm >/dev/null 2>&1; do sleep 1; done
docker exec litellm-pg-old pg_dump -U litellm -d litellm -Fc -f /tmp/litellm.dump
docker cp litellm-pg-old:/tmp/litellm.dump ./litellm.dump
docker rm -f litellm-pg-old

# 2) 起本目录的实例（库与角色由镜像建好）
docker compose -f docker/litellm/docker-compose.yml up -d litellm-postgres

# 3) 把备份灌进本目录实例的 litellm 库（--no-owner：对象归当前连接角色 litellm，不带入旧的属主与授权）
docker compose -f docker/litellm/docker-compose.yml cp ./litellm.dump litellm-postgres:/tmp/litellm.dump
docker compose -f docker/litellm/docker-compose.yml exec -T litellm-postgres \
  pg_restore -U litellm -d litellm --no-owner --no-privileges /tmp/litellm.dump
docker compose -f docker/litellm/docker-compose.yml exec -T litellm-postgres rm -f /tmp/litellm.dump

# 4) 起网关并验收（见「验证」）
docker compose -f docker/litellm/docker-compose.yml up -d
```

口径与坑：

- **`LITELLM_SALT_KEY` 必须填回原值**：它加密库内 Provider 凭据，换值的后果与下面「两个密钥」一节相同。
- 灌数据要赶在 litellm 首次启动**之前**（它启动时会自己建表，撞上就是一堆「对象已存在」的报错）。已经起过
  就先清空该库再灌，只动 litellm 这一个库：
  ```bash
  docker compose -f docker/litellm/docker-compose.yml exec -T litellm-postgres \
    psql -U litellm -d litellm -c 'DROP SCHEMA public CASCADE' -c 'CREATE SCHEMA public'
  ```
- **口令不进逻辑备份**：`pg_dump` 只导库内对象、不带角色口令，所以新旧实例的 `LITELLM_DB_PASSWORD` 不同不影响搬迁
  ——本目录 `.env` 与目标实例里的口令一致即可（不一致时先 `ALTER USER`，见「本目录自带的 PostgreSQL」）。
- 新旧都是 PostgreSQL 16（更早的自带实例是 `postgres:16-alpine`，共享实例也是 `postgres:16-alpine`），逻辑备份
  在这几者之间安全；跨大版本的物理搬迁不安全，这里不走那条路。

**B. 不迁、从零起（旧库没有要保留的数据，或本机开发）**：跳过上面第 1 步与第 3 步。库与角色由镜像建好，
空库启动后 litellm 自己建表；Provider / Model / Virtual Key 在管理页重新配一遍（它们是库里的运行时数据，
部署文件不持有）。旧数据原样留着，按下面的条件再删。

**旧数据什么时候可以删**：`docker/common/data/postgres`（共享实例时期，已随 `docker/common/` 一起删除）或命名卷
`litellm-postgres-data`（更早的自带实例）保留到——按 A 迁完、管理页里的 Provider / Model / Virtual Key 与迁移前
一致、且至少完成一次真实调用（用量页有记录）。在那之前它同时是回退路径（换回旧编排仍读它）：

```bash
docker volume rm litellm_litellm-postgres-data   # 不可逆：删掉这一份就只剩本目录 ./data/postgres 里的数据
```

### 备份与恢复

数据在本目录 `./data/postgres`（共享实例时期在 `docker/common/data/postgres`，那边的备份口径已作废）：

```bash
# 只备份网关库（在本目录的实例里导出；容器内 local socket 免口令）
docker compose -f docker/litellm/docker-compose.yml exec -T litellm-postgres \
  pg_dump -U litellm -Fc litellm > litellm-$(date +%Y%m%d).dump

# 恢复（先删库里已有对象；恢复后 LITELLM_SALT_KEY 必须与备份时同值）
docker compose -f docker/litellm/docker-compose.yml exec -T litellm-postgres \
  pg_restore -U litellm -d litellm --clean --if-exists < litellm-YYYYmmdd.dump
```

整实例口径见 `docs/operations/backup-and-restore.md`，但那里的 PostgreSQL 指**主服务自己的**实例
（`docker/main/data/postgres`，dev 形态在仓库根 `./data/postgres`）：网关库不在那份目录里，要单独备份——或者按
文件粒度把本目录 `./data/postgres` 一起 `tar` 走。`./docker/deploy.sh down --purge-data` 会把各依赖目录的
`./data/` 一起删掉，需要保留数据时不要用它。

### 两个密钥由「有默认值」改为「必需」的迁移口径

改造前 compose 给的是 `LITELLM_MASTER_KEY:-litellm-master-key` / `LITELLM_SALT_KEY:-litellm-salt-key`
（见 git 历史的 `docker/litellm/docker-compose.yml` 与已退役的 `docker/prod/docker-compose.litellm.yml`）。
现在两者都改为 `${VAR:?}`：master key 必须与平台侧 `RCS_MODEL_GATEWAY_ADMIN_KEY` 同值，静默落到内置默认值只会
在调用时变成难查的 401；salt key 用于加密库内 Provider 凭据。**已有数据的部署必须把 `LITELLM_SALT_KEY` 填回
此前生效的值**（若此前从未显式设置，就是上面那个默认值），否则旧凭据解不开。

## 验证

```bash
curl -fsS http://127.0.0.1:4000/litellm/health        # 预期 200（前缀语义见「待确认」）

# 栈内实例先健康（litellm 以它为准）
docker compose -f docker/litellm/docker-compose.yml ps litellm-postgres    # 期望 healthy

# 库与角色由镜像建好：两条 SELECT 各应输出一行 litellm
docker compose -f docker/litellm/docker-compose.yml exec -T litellm-postgres \
  psql -U litellm -d litellm -tA -c "select datname from pg_database where datname = 'litellm'" \
                              -c "select rolname from pg_roles where rolname = 'litellm'"
# 网关的表（空库启动后由 litellm 建出；这个数 > 0 说明角色能在自己库里建表）
docker compose -f docker/litellm/docker-compose.yml exec -T litellm-postgres \
  psql -U litellm -d litellm -tAc 'select count(*) from pg_stat_user_tables'

docker compose -f docker/litellm/docker-compose.yml ps
# 平台侧：登录控制台的系统管理页，网关卡片应显示健康；或直接看 rcs 日志里是否出现 401
```

验收要看**两处**：`litellm-postgres` 的 `healthy`（实例接受连接）与 `litellm` 自己的日志——健康检查用的
`pg_isready` 不验口令，口令漂移只有在 `litellm` 报 `password authentication failed` 时才暴露。

## 升级

改本目录 `docker-compose.yml` 的 `image` 行为目标版本（固定版本，不用 `latest`、不做变量插值），然后：

```bash
cd <仓库根>
docker compose -f docker/litellm/docker-compose.yml pull
docker compose -f docker/litellm/docker-compose.yml up -d
```

升级不需要额外的建库步骤：库与角色由 `litellm-postgres` 镜像在数据目录初始化时建好，`up -d` 会先等它 healthy
（见「数据与迁移」）。升级后核对管理页与平台的模型同步；跨大版本前先备份（口径见「备份与恢复」——网关库在本目录
`./data/postgres`，PostgreSQL 数据目录不能降级）。
