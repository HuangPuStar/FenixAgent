# RAGFlow（knowledge 依赖）

RAGFlow 检索栈：文档解析、切分、向量检索与知识库管理。knowledge 模块用它做 Agent 知识库的检索后端。

栈内 7 个服务：`ragflow`（API / Web 入口，`infiniflow/ragflow:v0.26.0`）、`ragflow-mysql-init` 与 `ragflow-s3-init`
（两个一次性初始化服务，执行完即退出）、`ragflow-redis`（Valkey，栈内保留）、`ragflow-rustfs`（S3 对象存储，**本栈自带**）、
`infinity`（向量与全文引擎）、`gotenberg`（Office 转 PDF，`gotenberg/gotenberg:8`）。
本目录自包含：`docker-compose.yml` + `.env.example` + 两个初始化脚本（`init-mysql.sh` / `init-s3.py`）+
`infinity_conf.toml`（Infinity 的只读配置挂载），不引用其他依赖目录的文件与卷。

元数据仍由 `docker/common/` 的共享 MySQL 提供；**对象存储由本目录自带**（`ragflow-rustfs`）——这是对
「S3 一律用共享 `docker/common/` 的 rustfs」的**特例**，裁定与理由见「本栈自带的 rustfs（为什么它是特例）」。
共享化因此只带来一个新前置条件（`FENIX_FEATURE_MYSQL`），代价与理由见下面「共享基础设施（一）」与「本栈自带的 rustfs」两节。

`gotenberg` 原先是独立依赖目录 `docker/gotenberg/`（独立开关 `FENIX_FEATURE_GOTENBERG`），现已并入本栈：
它与 `ragflow` 是 knowledge 文档链路上的一组依赖（先转 PDF、再解析），共用一份 `.env` 与一次启停，
因此**不再有独立开关**——`FENIX_FEATURE_RAGFLOW=true` 时两者一起启动。

未部署时（`FENIX_FEATURE_RAGFLOW=false`）主服务照常启动，知识库检索与 Office 转 PDF 一并降级——knowledge 模块把两者都
声明为 `required: false`，探活失败只告警。

## 拓扑

```text
浏览器 / 运维
  └─ 127.0.0.1:18080（Web UI）、127.0.0.1:19380（HTTP API）、127.0.0.1:3200（Gotenberg /health）
     ← 都只绑回环，仅供宿主使用

external 网络 fenix-server（顶层项目创建）：
    rcs ──→ ragflow:9380                        ← 容器形态：知识库检索出口
    rcs ──→ gotenberg:3000                      ← 容器形态：Office 转 PDF 出口
    ragflow ──→ mysql:3306                      ← 共享 MySQL（docker/common/，开关 FENIX_FEATURE_MYSQL）
    ragflow-mysql-init ──→ mysql:3306           ← 一次性：建库建号（建完即退出）

本项目的 ragflow-net（栈内网络，辅助服务与自带对象存储只在这里）：
    ragflow ──→ ragflow-redis:6379 / infinity:23817,23820,5432
    ragflow ──→ ragflow-rustfs:9000             ← 本栈自带的对象存储（特例：不接共享 rustfs、不接 fenix-server）
    ragflow-s3-init ──→ ragflow-rustfs:9000     ← 一次性：实例能力探测（建探测桶 + 读写 + 删除，建完即退出）
```

`ragflow` 同时挂在两张网上：对外是 `fenix-server` 上的 `ragflow`，对内访问栈内辅助服务（它必须接 ② 才能按服务名
访问共享 MySQL，§3）。`gotenberg` 只挂 `fenix-server`——它不依赖栈内任何服务，而网络成员是「需要与主服务
直接通信」的最小必要集。两个初始化服务各自只挂需要的那张网：`ragflow-mysql-init` 走 `fenix-server`
（共享实例只在 ② 上可按名寻址）、`ragflow-s3-init` 走 `ragflow-net`（对象存储就在本项目内），
且只在初始化期间存在。

## 前置条件

- Docker Engine 与 Docker Compose v2（本目录用标准 Compose 配置，无 `include` / profile 依赖）。
- **顶层项目已启动**：`fenix-server` 由顶层（仓库根 `docker-compose.yml`）创建，本目录只以 `external: true` 引用。
  单独跑本目录前先 `./docker/deploy.sh up`（或至少起来顶层项目），否则 `up` 会报
  `network fenix-server declared as external, but could not be found`。
- **共享基础设施已启用**：`docker/deploy.env` 里 `FENIX_FEATURE_MYSQL=true`。对象存储**不需要**任何开关——
  它是本栈自带的服务（`FENIX_FEATURE_S3` 只服务 `docker/workflow/` 的共享实例消费）。开关与依赖目录不自动联动
  （§6 末），缺 `MYSQL` 的表现是初始化服务带判定退出、`ragflow` 不启动，不会静默降级。
- 宿主端口 18080 / 19380 / 3200 未被占用（用 `.env` 的 `RAGFLOW_WEB_PORT` / `RAGFLOW_API_PORT` / `GOTENBERG_PORT` 可改）。
  三个默认值只绑回环，与仓库内其他依赖的回环端口（`POSTGRES_PORT` 5432、`MYSQL_HOST_PORT` 3306、`LITELLM_PORT` 4000、
  npm-registry 4873、`HINDSIGHT_API_HOST_PORT` 8888）不重叠；但 `docker/workflow/` 的宿主诊断入口默认也是 18080——**同机同时启用两栈时必须错开**。
- 机器资源与磁盘按实际语料规模评估：本栈自带 Valkey、Infinity 与对象存储（`ragflow-rustfs`）三套栈内存储，
  其中对象存储上的桶**随用户行为增长**（多桶模式：每个知识库 / 文件目录一个，见「多桶模式与本栈的键布局」），
  共享实例上只多出本栈的库 `rag_flow`。
- 应用侧还需装配层包含 knowledge 模块（`deploy/assembly/<profile>.json`）——部署开关 `FENIX_FEATURE_RAGFLOW`
  只决定「容器起不起」，模块加载是另一层（`docs/operations/docker-topology.md` §13）。

## 配置

应用侧（主服务读）的四个键在**仓库根 `.env`**；共享实例的凭据（本栈只用其中的 `MYSQL_ROOT_PASSWORD`）也在根 `.env`（§8.3）；
本目录 `.env`（模板 `.env.example`）只放本栈私有的键：

| 键 | 位置 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `RAGFLOW_API_URL` | 根 `.env` | `http://localhost:9380` | 主服务访问 RAGFlow API 的基址。**容器形态必须显式改**（见下节） |
| `RAGFLOW_API_KEY` | 根 `.env` | 空串 | RAGFlow API key，密钥；空串表示「未配置 RAGFlow」，检索链路快速失败 |
| `RAGFLOW_REQUEST_TIMEOUT_MS` | 根 `.env` | `30000` | 单次 HTTP 请求超时（毫秒，正整数） |
| `GOTENBERG_URL` | 根 `.env` | `http://127.0.0.1:3200` | 主服务访问 Gotenberg 的基址。**容器形态必须显式改为 `http://gotenberg:3000`**（见下节） |
| `MYSQL_ROOT_PASSWORD` | 根 `.env` | `root` | 共享 MySQL 的 root 口令：`ragflow-mysql-init` 用它建库建号 |
| `RAGFLOW_MYSQL_PASSWORD` | 本目录 `.env` | **无默认值（必需）** | 共享 MySQL 里 `ragflow` 账号的口令；初始化服务建号时写入（已存在则同步），`ragflow` 用它拼连接串 |
| `RAGFLOW_S3_ACCESS_KEY` / `RAGFLOW_S3_SECRET_KEY` | 本目录 `.env` | `ragflow` / `ragflow-local-dev`（编排里的缺省值） | 本栈自带 rustfs 实例的凭据：实例的 `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` 与 `ragflow` 的 `MINIO_USER` / `MINIO_PASSWORD` 都取它。与共享实例那对（`fenix` / `fenix-local-dev`）**刻意不同值**——同机两套实例用同一对凭据会造成「其实是同一个实例」的假象 |
| `RAGFLOW_WEB_PORT` | 本目录 `.env` | `18080` | Web UI 的宿主**回环**端口（容器内 80） |
| `RAGFLOW_API_PORT` | 本目录 `.env` | `19380` | HTTP API 的宿主**回环**端口（容器内 9380） |
| `GOTENBERG_PORT` | 本目录 `.env` | `3200` | Gotenberg 的宿主**回环**端口（容器内 3000） |
| `RAGFLOW_REDIS_PASSWORD` | 本目录 `.env` | `ragflow_redis_2026` | 栈内 Valkey 口令：`ragflow-redis` 与 `ragflow` 两处共用 |

四个应用侧键的真相来源是 `packages/resources/knowledge/fenix.module.ts` 的 `envDefinitions`（根 `.env.example` 由
生成器产出）。`RAGFLOW_MYSQL_PASSWORD` 是本编排唯一的 `${VAR:?}` 必需键：它落在多栈共用的实例里，仓库可见的默认
口令等于把库交给同机任何人；缺省时 `./docker/deploy.sh validate` 会点名它（其余键缺失时是静默使用默认值，
生产机器必须逐项核对，别把「能起来」当成「配置对了」）。

**为什么这些口令放在本目录 `.env` 而不是仓库根 `.env`**（与 `docker/litellm/` 的 `LITELLM_DB_PASSWORD` 不同）：
根 `.env` 按 §8.3 只放**跨项目共享**的键（共享实例的 root/凭据、主服务自用配置）。`ragflow@'%'` 这个账号与
`ragflow-rustfs` 这对凭据都只服务本栈——别的栈不读它、也不该读它；而「放依赖目录会与实例里的账号漂移」
这个顾虑在这里不成立：唯一的值来源就是本文件，初始化服务每次运行都把实例里的口令同步成它。
若要把根 `.env` 也纳入（与 litellm 完全同形），改动是 `scripts/lib/env-example-spec.ts` 的 `BASE_SERVICE_UNDECLARED`
里加一个条目 + 重跑 `bun run scripts/generate-env-example.ts`；这是可独立推进的一项，不阻塞本栈。

密钥类键只在 `.env` 里出现：不进 `docker/deploy.env`、不进 compose、不进 git（仓库根 `.env`、`docker/deploy.env`
与本目录 `.env` 三者都被 `.gitignore` 忽略，已用 `git check-ignore` 实测）。

### 与 knowledge 模块对接：根 `.env` 该填什么

| 运行形态 | `RAGFLOW_API_URL` | 说明 |
| --- | --- | --- |
| 主服务**在容器里**（`./docker/deploy.sh up`） | `http://ragflow:9380` | `ragflow` 是共享网络内的服务名，容器内的 `localhost` 不是宿主也不是别的容器 |
| 主服务**跑源码**（`bun run dev` / `restart-server.sh`） | `http://127.0.0.1:19380` | 走本目录发布的回环端口；改过 `RAGFLOW_API_PORT` 就跟着改 |

两种形态都填**不带尾斜杠**的基址：模块的探活路径是 `<RAGFLOW_API_URL>/api/v1/system/healthz`。
`RAGFLOW_API_KEY` 在 RAGFlow Web UI（`http://127.0.0.1:18080`）里生成后填进根 `.env`；它是密钥，不要贴进工单、日志或截图。

`GOTENBERG_URL` 的口径与它同规则（模块的探活路径是 `<GOTENBERG_URL>/health`）：

| 运行形态 | `GOTENBERG_URL` | 说明 |
| --- | --- | --- |
| 主服务**在容器里** | `http://gotenberg:3000` | `gotenberg` 是共享网络内的服务名；模块声明的默认值 `http://127.0.0.1:3200` 在容器内指向主服务自己，必须显式改 |
| 主服务**跑源码** | `http://127.0.0.1:3200` | 走本目录发布的回环端口，与模块默认值一致；改过 `GOTENBERG_PORT` 就跟着改 |

容器内的端口是 3000（不是宿主回环的 3200）：宿主端口只服务源码运行，容器之间不走它。

## 共享基础设施（一）：MySQL

元数据库改用 `docker/common/` 的共享 `mysql`（实例与账号由 common 提供，业务初始化归本栈）：
原先栈内的 `mysql` 服务已删除，容器内地址仍是 `mysql:3306`（服务名与端口在 common 里保持原值，`MYSQL_HOST` / `MYSQL_PORT` 不变）。

- **只提供实例、不提供业务初始化**（§5.1）：common 的 `MYSQL_DATABASE` / `MYSQL_USER` 只在实例**数据目录首次初始化**
  时生效，对已经存在的实例（别的栈先起过）完全无效。所以本栈自带一次性服务 `ragflow-mysql-init`：等实例就绪 →
  幂等建库建号授权 → 用本栈账号自检。
- **账号是分开的**：`ragflow@'%'` 只对 `rag_flow` 库有权限（`GRANT ALL PRIVILEGES ON \`rag_flow\`.*`），
  与 workflow 的 `coze` 账号、与实例 root 都不是同一个。共享实例上按栈分账号，是为了让一个栈的口令轮换、
  越权访问都不外溢到别的栈；代价是共享实例上多一个账号对象、多一份要跟着 `.env` 走的口令。
- **不建表**：schema 由 RAGFlow 镜像自己的启动流程创建（`docker/entrypoint.sh` 调 `tools/scripts/mysql_migration.py`）。
  本栈的初始化服务只保证「库在、号在、权限够」，升级 RAGFlow 镜像时 schema 迁移照旧自动跑。
- **参数差异**（旧栈内实例 vs 共享实例，都不阻挡启动，但换实例后行为不同，排障时要记得）：
  旧实例是 `--max_connections=1000`、`--binlog_expire_logs_seconds=604800`、写死 `--default-authentication-plugin=mysql_native_password`；
  共享实例用镜像默认（`max_connections` 151）与 `caching_sha2_password`。RAGFlow 的客户端是
  `mysql-connector-python>=9`（镜像 pyproject），支持 `caching_sha2_password`；连接池大小由 service_conf 的
  `max_connections: 900` 控制，与服务器端 151 不是同一个东西——多栈同时压库时才需要调 common 的
  `max_connections`（见文末「需要 common 配合的点」）。
- **`MYSQL_MAX_PACKET`**（客户端 1GB）保持原值：旧栈内实例同样没在服务器端调过 `max_allowed_packet`，
  所以这不是本次引入的差异；真要传大包时在共享实例上调（同上）。

## 本栈自带的 rustfs（为什么它是特例）

对象存储**由本栈自带**：栈内服务 `ragflow-rustfs`（`rustfs/rustfs:1.0.1`，与 common 的共享实例同版本），
原先栈内的 `minio` 服务已删除，`MINIO_HOST` 指向 `ragflow-rustfs`，`MINIO_PORT` 仍 9000。
镜像仍只用 RustFS（不引回 MinIO）——被放弃的只是「用共享那一套实例」这件事。

**这是「S3 一律用共享 `docker/common/` 的 rustfs」的例外，且是用户裁定**（`docker-topology.md` §5、§13 规则 1 的
例外条目）：RAGFlow 用多桶模式（见下），桶名是运行期 UUID，而共享实例只有**全实例一对凭据**、实例侧也给不出
「按消费方的桶策略」——两条合起来，在共享实例上无法为它建立有效的隔离边界。隔离到自己的实例后，
「拿到凭据就能读写别的栈的桶」与「跨栈桶命名空间」两个问题同时消失。四条边界（照抄不放大，改之前先读 §5）：

1. 仍只用 RustFS 镜像，不引入 MinIO 或第二套对象存储实现；
2. **不接 `fenix-server`**：它只在 `ragflow-net`，因此没有跨项目寻址需求、也不占全局保留名；
3. **不发布宿主端口**（要本机调试时按 compose 里被注释的两行放开，且只绑回环，§6.4）；
4. 服务名**不叫 `rustfs`**——那是共享实例在 `fenix-server` 上的保留名（§3 规则 7）：`ragflow` 容器同时挂在两张网上，
   栈内若也有一个 `rustfs`，它解析这个名字时两条记录都会被返回。处置与栈内 Valkey 相同（`ragflow-redis`）。

### 多桶模式与本栈的键布局

本栈**不设桶名**（编排里不注入 `MINIO_BUCKET`，上游的 `minio.bucket` 不被覆盖），即 RAGFlow 的**多桶模式**：每个「逻辑桶」
就是本栈实例上的一个真实桶，对象键就是对象名本身。这是**用户裁定**的形态（理由见下），不是漏配、也不是待补的项。
证据来自镜像内的客户端代码（`rag/utils/minio_conn.py`，v0.26.0）：

- 逻辑桶的取值是**动态**的：`api/db/services/file_service.py` 用 `kb.id`（知识库 id）与 `file.parent_id`（文件目录 id）
  调 `STORAGE_IMPL.put/get`，`api/db/services/file2document_service.py` 的 `get_storage_address` 也返回 `parent_id` / `kb_id`
  ——两者都是 UUID，**桶名在部署时不可知**；
- 不覆盖桶名时 `use_prefix_path` 装饰器不拼 `<orig_bucket>/` 前缀（键就是对象名）；
- 于是 `put()` 里那句 `if not self.bucket and not self.conn.bucket_exists(bucket): make_bucket(bucket)` **会执行**：
  **桶由 RAGFlow 在首次写入时自建**；`health()` 仍只做 `bucket_exists`。任何初始化服务都无法预建这些桶（名字
  事先不存在），`ragflow-s3-init` 因此只做实例能力探测（见「一次性初始化服务」）。

**为什么选多桶**：它与**既有存量数据布局一致**——升级前的编排从未覆盖过桶名（`git show <升级前提交>:docker/ragflow/docker-compose.yml`
里只有 `MINIO_HOST` / `MINIO_PORT` / `MINIO_USER` / `MINIO_PASSWORD`），生产环境里已积累的 RAGFlow 对象就是
「一个逻辑桶一个物理桶」。布局一致意味着搬迁时对象键不用重打，见「数据搬迁」的 A 口径。

**已知代价**（只影响本栈，不再外溢）：桶名由用户行为决定（每个知识库、每个文件目录一个 UUID 桶），
数量随使用增长、事先不可枚举，因此本栈的桶**给不出一份可核对的清单**——运维上意味着
「按桶遍历」是备份与搬迁的唯一办法（见「数据落点」与「数据搬迁」），也意味着不能给本实例配「只允许访问某些桶」
的窄策略。这些代价都由本栈自己的实例承担，不再牵涉别的栈。

**警告**：事后擅自设回 `MINIO_BUCKET`（覆盖上游的 `minio.bucket`）会把键布局改成 `<逻辑桶>/<对象名>`（`use_prefix_path`
生效），已有对象**全部读不到**——那是数据可见性回归，必须先按「数据搬迁」做对象搬迁，不能只加一行环境变量。

### 端点、寻址、region、凭据

| 维度 | 取值 | 依据 |
| --- | --- | --- |
| 端点 | `ragflow-rustfs:9000`（容器内显式值，不插值宿主键） | 本栈实例在 `ragflow-net` 上的服务名，见 `docker/ragflow/docker-compose.yml` 的 `ragflow-rustfs` |
| 寻址 | **path-style**（`http://ragflow-rustfs:9000/<bucket>/<key>`） | RAGFlow 用 minio-py 7.2.4（镜像 `pyproject.toml`）：`minio/helpers.py` 的 `_virtual_style_flag` 只在 AWS 域名（或 `aliyuncs.com`）上为真，非 AWS 端点一律路径式 |
| region | 由客户端发现：先 `GET /<bucket>?location=`，服务端返回空则按 `us-east-1` | `minio/api.py` 的 `_get_region`；`ragflow-s3-init` 会把实测到的 region 打进日志 |
| 签名 | SigV4（payload 哈希；不需要 aws-chunked 流式签名） | minio-py 7.2.4 不带 `STREAMING-AWS4-HMAC-SHA256-PAYLOAD`；本地 `rustfs/rustfs:1.0.1` 镜像的二进制里该标记与 `GetBucketLocation` 均存在（`grep -a -F 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD'`），双向都成立 |
| 凭据 | 本目录 `.env` 的 `RAGFLOW_S3_ACCESS_KEY` / `RAGFLOW_S3_SECRET_KEY` | 本栈私有键：`ragflow-rustfs` 的 `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` 与 `ragflow` 的 `MINIO_USER` / `MINIO_PASSWORD` 都取它，不读仓库根 `.env` 的共享 `RUSTFS_*` |

`ragflow-s3-init` 就是这套判断的可执行形式：它用 RAGFlow 自带的 minio 客户端列桶（验证端点 + 凭据）、建一个
自己的探测桶、写入-读回-删除一个探测对象、再删掉探测桶（验证 path-style 寻址、region 协商、签名与
**建桶 / 读写 / 删对象权限**——正是 RAGFlow 自建逻辑桶时会走的路径）。它通过，`ragflow` 就能用同一个客户端读写
同一批端点——失败在启动前暴露，而不是等第一次检索。

**凭据范围**：本栈自带实例之后，凭据只在本栈内部使用——`ragflow` 能读写的桶全在本实例里，
别的栈（`docker/workflow/` 的 `opencoze` / `milvus`）在共享实例上、与本栈的凭据无关。共享实例那对
「全实例一对凭据」的代价对本栈因此不再成立（它只剩 `docker/workflow/` 一个消费方，见 §5）。
本栈内部的实际约束是：多桶模式下 RAGFlow 会按用户行为创建一批 UUID 命名的桶，
**「只碰自己创建的桶」是约定而不是权限保证**——但越界范围止于本实例，且本实例只有本栈在读写。

## 共享 Redis（为什么不换）

`docker/common/` 的 `redis`（`redis:7-alpine`，`--appendonly yes`，无鉴权）**没有**被本栈采用：栈内仍是
`valkey/valkey:8`，只把服务名从 `redis` 改成 `ragflow-redis`（保留名避让，见下节）。四条证据：

1. **无鉴权这件事，RAGFlow 走不通。** 共享实例没有 `requirepass`；而 RAGFlow 的入口脚本对模板行
   `${REDIS_PASSWORD:-infini_rag_flow}` 的判定是「环境变量非空才替换，否则回退默认值」（`docker/entrypoint.sh`
   的模板渲染循环），因此把 `REDIS_PASSWORD` 设成空串**不会**得到空口令，只会退回内置默认 `infini_rag_flow`；
   客户端随后会 `AUTH infini_rag_flow`（`rag/utils/redis_conn.py` 只在口令非空时才带 `password` 参数），
   对着无口令实例必然报 `ERR Client sent AUTH, but no password is set`。除非改镜像内模板（把上游文件复制进本仓），
   否则「指向无口令实例」这条路径不存在。
2. **内存上限与淘汰策略是服务端属性，换实例就丢了。** RAGFlow 给它自己的 redis 配
   `--maxmemory 256mb --maxmemory-policy allkeys-lru`（上游 128mb），RAGFlow 的 `service_conf.yaml` 里**没有**
   任何对应的客户端设置；共享实例不设 `maxmemory`（上限即宿主机内存、默认 `noeviction`）。
   两个消费方的最优策略互相冲突：RAGFlow 要「可淘汰的缓存」（它把解析任务队列放 Redis Streams，缓存与队列同库），
   RCS 要「不许悄悄丢」（Y.Doc 快照 `chat:{rcsSessionId}`、`session:{rcsSessionId}` 是持久化语义，被 LRU 淘汰就是静默丢数据）。
   往任一方向调都会牺牲另一方的语义，这不是「等价替换」。
3. **键空间混居。** RAGFlow 固定用 `db: 1`（`docker/service_conf.yaml.template` 里的 `redis: db: 1`，不是环境变量），
   共享实例的 db 1 会同时装着 RAGFlow 的任务队列/缓存与任何同样用 db 1 的消费方；RCS 用的是连接串里的库号
   （`RCS_REDIS_URL`），靠约定而非隔离。且 RCS 支持 `RCS_REDIS_CLUSTER`，而集群模式只有 db 0——该部署形态下
   RAGFlow 的 `db: 1` 根本不存在。
4. **版本与专有行为不是障碍，所以决策不靠它。** RAGFlow 用的是 valkey 客户端 `valkey==6.0.2`（RESP 协议），
   命令面是标准集（`SET/GET/INCR/ZADD/XADD/XGROUP/XINFO/PIPELINE/EVAL`，见 `rag/utils/redis_conn.py`），
   Redis 7.4 全部支持；本机 `redis:7-alpine` 的实际版本是 7.4.11（`docker image inspect redis:7-alpine` 的
   `REDIS_VERSION` 环境变量）。也就是说「协议上能换、语义上不能换」——决定来自上面三条。

**保留栈内的代价**：共享实例的内存省不下来，`redis` 这个保留名在本栈仍有一个同名角色（只是被改名隔离）。
**重新评估的条件**：common 的 redis 提供鉴权（`requirepass` 或 ACL 用户）**且**能给到与 RAGFlow 匹配的
`maxmemory` / 淘汰策略（例如为共享实例单独划分 db 与策略，或由 common 提供第二个「可淘汰」实例）。
那时的判定命令与验收见「验证」一节的第 5 步。

## 网络接入清单

| 服务 | 接入 `fenix-server` | 理由 |
| --- | --- | --- |
| `ragflow` | 是 | 知识库检索出口：主服务要直连它的 API（`http://ragflow:9380`），Web/API 共用这一个容器；同时要按服务名访问共享 `mysql`（对象存储在项目网络里） |
| `gotenberg` | 是 | Office 转 PDF 出口：主服务要直连它（`http://gotenberg:3000`）。服务名 `gotenberg` 在本仓其余栈里没有重名（已全量核对 `docker/`） |
| `ragflow-mysql-init` | 是 | 一次性：共享 `mysql` 只能在 ② 上按服务名寻址；它不访问栈内任何服务，因此不挂 `ragflow-net` |
| `ragflow-s3-init` | **否** | 一次性：它只访问同项目的 `ragflow-rustfs`，因此只挂 `ragflow-net`（接入面越小，跨项目 DNS 名越不容易撞车）。服务名刻意带 `ragflow-` 前缀：`mysql-init` 已被 `docker/workflow/` 用掉，而 `mysql-init` / `s3-init` 那类名字在 `fenix-server` 上必须全局唯一 |
| `ragflow-rustfs` | **否** | **本栈自带的对象存储**（特例，见「本栈自带的 rustfs」）：没有跨项目寻址需求，因此不接共享网络、不占保留名 `rustfs`、不发布宿主端口 |
| `ragflow-redis` | 否 | 辅助服务：只被 `ragflow` 访问，主服务不应直连；且 `redis` 是共享实例的保留名 |
| `infinity` | 否 | 辅助服务：向量与全文引擎，只被 `ragflow` 访问 |

**保留名避让**（§3 规则 7）：共享基础设施的服务名 `postgres` / `redis` / `rustfs` / `mysql` 是全局保留名。
`ragflow` 同时挂在两张网上，栈内若还有同名服务，Docker 的容器 DNS 没有优先级约定（两边记录都会被返回），
解析结果取决于返回顺序。本栈的处置：`mysql` 与 `minio` 已删除（前者随共享化、后者换成自带 rustfs），
栈内 Valkey 改名 `ragflow-redis` 并把 `REDIS_HOST` 指向它，自带对象存储命名 `ragflow-rustfs`。
判定命令（共享实例已起时执行，期望只看到栈内那个地址）：

```bash
docker compose -f docker/ragflow/docker-compose.yml exec ragflow getent hosts ragflow-redis ragflow-rustfs
docker compose -f docker/ragflow/docker-compose.yml exec ragflow getent hosts redis   # 期望：无输出或只有共享实例
docker compose -f docker/ragflow/docker-compose.yml exec ragflow getent hosts rustfs  # 期望：同上（共享实例才叫 rustfs）
```

`gotenberg` 的代价说明：它进了主服务层，因此它的容器一旦被攻破就与主服务同网——这是「让主服务直连」的直接代价，
换来的收益是不必为它再从宿主回环端口绕一圈。它不挂 `ragflow-net`，与栈内辅助服务互不可见。

另一个代价是**开关共用**：只想要 Office 转 PDF、不要知识库检索的机器，也必须把整个 RAGFlow 栈（含共享 MySQL）拉起来。
这是「两者同属一个目录」的必然结果；若这种部署形态真的出现，正确做法是把 gotenberg 拆回独立目录并恢复独立开关
（§7：一个开关对应一个目录），而不是在本目录里造第二个开关。

核对方式：

```bash
docker network inspect fenix-server --format '{{range .Containers}}{{.Name}} {{end}}'
# 期望：只出现本栈的 ragflow、gotenberg 两个常驻容器（以及 rcs、common 的基础服务与其他依赖的出口服务）；
# 栈内辅助服务与自带对象存储（ragflow-redis / infinity / ragflow-rustfs）不应出现在这里。
# 初始化服务是短生命周期容器：正在跑的时候才会出现，跑完即退出（其中 ragflow-s3-init 只在 ragflow-net 上，
# 本来就不会出现在这份 fenix-server 名单里）。
```

## 一次性初始化服务

两个服务都 `restart: "no"`、只读挂载脚本、失败经 `ragflow` 的 `depends_on: service_completed_successfully`
反映出来，不会静默变成「ragflow 起来了但库没准备好」。等待方式两者不同：**跨项目**那一个
（`ragflow-mysql-init` → 共享 `mysql`）只能自己带超时与分支诊断地重试——跨项目的 `depends_on` 在 compose 里
不成立（`depends on undefined service`）；**同项目**那一个（`ragflow-s3-init` → `ragflow-rustfs`）由
`depends_on: condition: service_healthy` 保证就绪，脚本自身的窗口只兜「健康检查已过、S3 API 尚未完全就绪」的缝隙。

### `ragflow-mysql-init`（脚本 `./init-mysql.sh`）

| 阶段 | 做什么 | 幂等手法 |
| --- | --- | --- |
| ① 等实例 | `SELECT 1` 探活，最多 300 秒 | 探活不修改任何对象；失败按「认证失败 / 不可达」分支给出判定 |
| ② 建库建号 | `CREATE DATABASE IF NOT EXISTS`（写死 utf8mb4 / utf8mb4_unicode_ci）、`CREATE USER IF NOT EXISTS`、`ALTER USER` 同步口令、`GRANT ALL ON \`rag_flow\`.*` | `IF NOT EXISTS` 原生幂等；口令同步让「改 `.env` 后重跑」即收敛，不需要进库手工 ALTER |
| ③ 自检 | 用 `ragflow` 账号连一次并选库；查 `information_schema.schema_privileges` 确认库级授权落地，并把 `SHOW GRANTS` 原文打进日志 | 只读查询，不建探测表、不留垃圾 |

「对象已存在」按信息模式先查出来并打印（`information_schema.schemata` / `mysql.user`），重跑时日志一眼能看出是
创建还是跳过。库名与账号名写死在 compose 里，不经部署环境传入（它们不是部署参数）。
口令先转义反斜杠与单引号再拼进 `-e`（mysql 客户端没有绑定参数），转义只做一次、顺序固定。

### `ragflow-s3-init`（脚本 `./init-s3.py`）

| 阶段 | 做什么 | 幂等手法 |
| --- | --- | --- |
| ① 等实例 | `list_buckets()` 探活（同时验证端点可达与凭据可用），最多 60 秒 | 只读调用；凭据类错误（服务端已应答但拒绝）立即失败并给判定，连接类错误才重试。窗口比 `ragflow-mysql-init` 短：同项目的 `service_healthy` 已经是闸门，这里只兜缝隙 |
| ② 探测桶 | 硬编码的 `ragflow-init-probe`：`bucket_exists()` → 不存在才 `make_bucket()`，并记下「这个桶是本次创建的」 | 已存在则沿用、只探测不删除（更可能是上次中断的残留）；探测桶写死在代码里、不做成环境变量——它没有部署维度，可配置只会多一个能被改错、并可能把探测指到别人桶上的旋钮 |
| ③ 读写探测与收尾 | `put_object` → `stat_object` → `get_object` 读回比对 → `remove_object` → 建桶时再 `remove_bucket()` | 探测对象是固定名 `_fenix_init_probe`，每次跑完都删；删除对象 / 删桶失败只告警并提示复核权限，不阻断。**只删自己建的桶**：不是本服务创建的桶绝不删除——实例上还有 RAGFlow 自建的 UUID 业务桶，本服务对它们不做任何决定 |

它用 python 而不是 shell，是因为 S3 要自己算 SigV4 与 region 协商，而镜像里本来就有 RAGFlow 运行期的同一个客户端
（minio-py 7.2.4）——于是初始化同时是**兼容性验证**，且不需要引入 `mc` / `aws-cli` 这类额外客户端镜像。
**多桶模式下它不建本栈的业务桶**（桶名是运行期 UUID，见上「多桶模式与本栈的键布局」），留下它是为了 fail-fast：
把端点、凭据、path-style 寻址、SigV4 签名、region 协商与**建桶 / 读写 / 删对象权限**在 `ragflow` 启动前验一遍，
任何一项不成立都在这里停下、以非 0 退出（`ragflow` 依赖它的 `service_completed_successfully`）。

## 数据搬迁

共享化与特例把两个数据落点都移出了本目录：元数据 → `docker/common/data/mysql`（共享实例），
对象数据 → `docker/ragflow/data/rustfs`（**本栈自带的 rustfs 实例**，见「本栈自带的 rustfs」）。
本目录旧的两个 bind 目录（`./ragflow_mysql_data`、`./ragflow_minio_data`）**本栈不再读写**，处置分两条口径。

先记下旧凭据（升级后 `.env.example` 不再列栈内 MinIO 的两项，搬迁时还要用）：

```bash
# 旧口令在升级前的 docker/ragflow/.env 里（旧版默认值：RAGFLOW_MYSQL_PASSWORD=ragflow_root_2026、
# RAGFLOW_MINIO_USER=rag_flow、RAGFLOW_MINIO_PASSWORD=infini_rag_flow）。搬迁前把这三个值抄到手边。
```

### A. 迁移既有数据（生产走这条）

**A1 元数据（MySQL 8.0.39 实例 → 共享实例的 `rag_flow` 库）**：两个实例的数据目录不能互拷（共享实例的
数据目录里还有别的栈的库），所以只能 SQL 级导出/导入。

```bash
# 0) 导出必须在旧编排上做：升级前先做；已经升级了就用升级前的提交临时装回旧编排（临时文件别提交）
git show <升级前提交>:docker/ragflow/docker-compose.yml > docker/ragflow/docker-compose.legacy.yml
docker compose --env-file docker/ragflow/.env --env-file ./.env \
  -f docker/ragflow/docker-compose.legacy.yml up -d mysql
docker compose --env-file docker/ragflow/.env --env-file ./.env \
  -f docker/ragflow/docker-compose.legacy.yml exec -T mysql \
  mysqldump -uroot -p"$RAGFLOW_MYSQL_PASSWORD" --single-transaction --routines --events --triggers \
  --set-gtid-purged=OFF --databases rag_flow > /tmp/rag_flow.sql

# 1) 打开开关起共享服务（ragflow-mysql-init 会先建好库与账号）
./docker/deploy.sh validate && ./docker/deploy.sh up

# 2) 导入（用共享实例的 root；口令从仓库根 .env 取，避免 source 展开值里的特殊字符）
MYSQL_ROOT_PASSWORD="$(grep -m1 '^MYSQL_ROOT_PASSWORD=' ./.env | cut -d= -f2-)"
docker run --rm -i --network fenix-server -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" \
  -v /tmp/rag_flow.sql:/dump.sql:ro mysql:8.4.5 \
  sh -c 'mysql -h mysql -u root -p"$MYSQL_ROOT_PASSWORD" < /dump.sql'

# 3) 验收：表数量与旧库一致，且 ragflow 容器能启动、既有知识库能检索
docker run --rm --network fenix-server -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" mysql:8.4.5 \
  sh -c 'mysql -h mysql -u root -p"$MYSQL_ROOT_PASSWORD" -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"rag_flow\""'
# 浏览器 http://127.0.0.1:18080 里点开一个既有知识库做一次检索；再上传一个 Office 文档验证新写入路径
```

**A2 对象数据（旧 MinIO 的每个桶 → 本栈自带实例上的同名桶，键不变）**：
多桶模式下这一步是**逐桶原样复制、键不变**（依据见上「多桶模式与本栈的键布局」）：旧桶名就是逻辑桶名（知识库
`kb_id` / 文件目录 `parent_id`），新实例上的桶名与它**逐字相同**（同一个 UUID），所以对象键不用重打，数据库里
存的引用（桶名 + 对象名，即 `get_storage_address` 返回的那套）也不用改——这正是选多桶换来的收益。

**仓库里没有 S3 客户端**：本编排不引入 `mc` / `aws-cli` 一类制品（`ragflow-s3-init` 用的是 ragflow 镜像自带的
minio-py，理由见 `init-s3.py`；`docker/workflow/README.md` §8 的取舍与此一致）。搬迁窗口里用任意一个现成客户端
即可——`mc` / `rclone` / `aws-cli` / minio-py，动作都是同样三步：① 列出旧实例的所有桶；② 逐桶原样复制到本栈
实例上的**同名**桶（不做任何前缀映射）；③ 断言桶名一致、抽样对象能读回。下面以 `mc` 为例（旧栈那个 MinIO 镜像
自带 `/usr/bin/mc`），跑完即弃。

搬迁容器要同时够到两侧：旧实例是临时容器（挂在哪个网络由你决定），新实例 `ragflow-rustfs` **只在项目网络里**
（它不接 `fenix-server`，见「本栈自带的 rustfs」）。最省事的做法是把两个临时容器都挂到本栈项目网络上，
网络名从运行中的容器反查、不要写死项目名：

```bash
# 0) 取本栈实例所在的网络名（顶层与本栈都已 up；换机器 / 改过项目名都不用改这段）
NET=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
      "$(docker compose -f docker/ragflow/docker-compose.yml ps -q ragflow-rustfs)" | awk '{print $1}')

# 1) 若旧实例不在跑：用旧数据目录临时起一个只读用途的 MinIO，挂同一个网络（只为读，别往里写）
docker run -d --rm --name ragflow-minio-legacy --network "$NET" \
  -v "$PWD/docker/ragflow/ragflow_minio_data:/data" \
  pgsty/minio:RELEASE.2026-03-25T00-00-00Z server /data

# 2) 用任意客户端逐桶复制。下面的 mc 来自旧栈镜像（一次性动作，不进入任何交付编排）；
#    宿主已装 mc / rclone 时直接用宿主态命令，`aws s3 sync` / minio-py 的写法同形。
#    新实例的凭据取本目录 .env（未显式配置时是编排缺省值 ragflow / ragflow-local-dev）。
S3_ACCESS_KEY="$(grep -m1 '^RAGFLOW_S3_ACCESS_KEY=' docker/ragflow/.env | cut -d= -f2-)"
S3_SECRET_KEY="$(grep -m1 '^RAGFLOW_S3_SECRET_KEY=' docker/ragflow/.env | cut -d= -f2-)"
docker run --rm -it --network "$NET" --entrypoint sh \
  -e OLD_USER="$RAGFLOW_MINIO_USER" -e OLD_PASSWORD="$RAGFLOW_MINIO_PASSWORD" \
  -e S3_ACCESS_KEY="${S3_ACCESS_KEY:-ragflow}" -e S3_SECRET_KEY="${S3_SECRET_KEY:-ragflow-local-dev}" \
  pgsty/minio:RELEASE.2026-03-25T00-00-00Z -c '
    command -v mc || { echo "本镜像没有 mc，改用客户端镜像"; exit 1; }
    mc alias set legacy http://ragflow-minio-legacy:9000 "$OLD_USER" "$OLD_PASSWORD"
    mc alias set shared http://ragflow-rustfs:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
    # 复制而不是 mv：旧的 ./ragflow_minio_data 在验收通过前是回滚路径，必须原样留着
    for b in $(mc ls legacy/ | awk "{print \$NF}" | sed "s:/$::"); do
      echo "== $b"; mc mirror --preserve "legacy/$b" "shared/$b"
    done
    # 断言一：旧实例里的每个桶都在新实例上、桶名逐字相同（缺一个就打印，期望无输出）
    for b in $(mc ls legacy/ | awk "{print \$NF}" | sed "s:/$::"); do
      mc stat "shared/$b" >/dev/null || echo "缺失桶：$b"
    done
    # 断言二：逐桶对象数一致（旧 vs 新），数量一致才算搬完
    for b in $(mc ls legacy/ | awk "{print \$NF}" | sed "s:/$::"); do
      printf "%s 旧=%s 新=%s\n" "$b" "$(mc ls --recursive legacy/$b | wc -l)" "$(mc ls --recursive shared/$b | wc -l)"
    done
    # 断言三（抽样）：挑第一个桶的第一个对象从新实例读回，字节数非 0 即说明键与内容都在
    b=$(mc ls legacy/ | awk "{print \$NF}" | sed "s:/$::" | head -n1)
    k=$(mc ls --recursive "legacy/$b" | awk "{print \$NF}" | head -n1)
    mc cat "shared/$b/$k" | wc -c'

# 3) 收尾：停掉临时旧实例，让 ragflow 用本栈实例跑一次真实检索/预览验收
#    （断言四：既有知识库能检索、既有文档能预览——这一步用浏览器或 knowledge 页面做，命令替代不了）
docker stop ragflow-minio-legacy
```

搬迁期间两处都有人写会丢数据：**先停栈（`docker compose -f docker/ragflow/docker-compose.yml down`）再搬**，
搬完再按「验证」起栈。搬完到验收通过之前不要动旧目录。

### B. 不迁、从零起（本机开发，或旧数据不要了）

不跑上面任何一步：`ragflow-mysql-init` 会在共享实例里建出空库（表由 RAGFlow 启动时建），`ragflow-s3-init` 只验
一遍本栈实例的能力（建探测桶 → 读写 → 删对象 → 删桶）。**实例上不会预先出现本栈的业务桶**：多桶模式下第一个
知识库 / 文件目录写入时桶由 RAGFlow 自建（这不是漏建，见「多桶模式与本栈的键布局」）。旧的 `./ragflow_mysql_data`、
`./ragflow_minio_data` 原样留着不动，随时可以回到旧编排。

### 旧目录保留与删除条件

| 旧目录 | 内容 | 什么时候可以删 |
| --- | --- | --- |
| `docker/ragflow/ragflow_mysql_data` | 旧实例的元数据（知识库、文档、切片、任务记录） | 按 A1 搬完并通过验收（表数量一致 + 一次真实检索）**且**至少跑过一个业务周期、确认不需要回退旧编排之后。删之前先 `tar -czf` 留一份 |
| `docker/ragflow/ragflow_minio_data` | 旧对象存储（原始文档与解析产物） | 按 A2 搬完且逐桶对象数一致、验收通过之后，同样先 `tar` 留一份 |

两个目录都属 `.gitignore`（`ragflow_*_data/` 规则），且**不在** `./docker/deploy.sh down --purge-data` 的清理清单内
（脚本只清理各依赖目录的 `./data/`）——要清空必须手动删，删之前确认不再需要里面的知识库内容。

`./ragflow_redis_data`（栈内 Valkey）与 `./ragflow_infinity_data`（Infinity 索引）**没有变化**，本次不搬、不删。

## 凭据与默认口令

- 共享实例的 root 口令在仓库根 `.env`（`MYSQL_ROOT_PASSWORD`），必须与 common 启动实例时用的值一致——
  不一致时 `ragflow-mysql-init` 会以「root 认证失败」停下，而不是让 `ragflow` 带着错的凭据跑。
  `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` 是**共享 rustfs 实例**的凭据，本栈已经不用（见「本栈自带的 rustfs」）。
- 本栈自己的口令/凭据都在本目录 `.env`：`RAGFLOW_MYSQL_PASSWORD`（无默认值，必需）、
  `RAGFLOW_S3_ACCESS_KEY` / `RAGFLOW_S3_SECRET_KEY`（默认 `ragflow` / `ragflow-local-dev`，仓库可见，
  只够本机隔离环境用）与 `RAGFLOW_REDIS_PASSWORD`（默认 `ragflow_redis_2026`，同上）。值用
  `openssl rand -hex 32` 一类方式生成，只写进 `.env`（不进 `docker/deploy.env`、不进 compose、不进 git）。
- MySQL 账号口令的生效方式变了：以前是「只在栈内实例数据目录为空时生效」，现在是**每次重跑 `ragflow-mysql-init`
  都会把账号口令同步成 `.env` 里的值**（账号只属于本栈，见脚本头注释），所以改口令只需改 `.env` 再重跑初始化，
  不需要清空数据目录。Valkey 仍是每次启动从命令行取口令，改 `.env` 即生效。
- **镜像内置的 Web 登录凭据：本仓文件读不出来。** 本编排没有注入任何登录类 env（`docker-compose.yml` 里只有
  连接串与端口），登录行为取决于镜像内置默认值。确认方法（任选其一，起栈后做）：
  1. `docker compose -f docker/ragflow/docker-compose.yml logs ragflow | grep -i -m5 'admin\|password'`；
  2. 直接打开 `http://127.0.0.1:18080`，按页面提示走首次注册——本编排保留了 `REGISTER_ENABLED: 1`（自助注册开放），
     首次注册的账号通常是管理员，**这一点请以该版本实际行为为准**；
  3. 查 `infiniflow/ragflow:v0.26.0` 的官方说明与镜像内 `.env`。
- `--enable-adminserver` 已开启（容器内管理端口 9381），但本编排**未**发布它的宿主端口：要访问只能经容器网络，
  不要为了图方便把它绑到 `0.0.0.0`。

## 数据落点

| 宿主路径 | 容器内 | 内容 | 本次改动的去向 |
| --- | --- | --- | --- |
| `./data/rustfs` | `/data` | **本栈自带 rustfs 实例的对象数据**（多桶布局：每个知识库 / 文件目录一个桶） | **新落点**（契约 §13.8 的 `./data/...` 形态）；`ragflow_minio_data` 的旧数据搬到这里 |
| `./ragflow_data` | `/ragflow/data` | RAGFlow 运行数据（解析产物、模型缓存等） | 不变 |
| `./ragflow_logs` | `/ragflow/logs` | 服务日志 | 不变 |
| `./ragflow_redis_data` | `/data` | Valkey 持久化文件 | 不变（Redis 未换） |
| `./ragflow_infinity_data` | `/var/infinity` | Infinity 索引数据 | 不变 |
| `./infinity_conf.toml` | `/infinity_conf.toml:ro` | Infinity 配置（只读挂载，版本写死 0.7.0，与镜像 tag 一致） | 不变 |
| ~~`./ragflow_mysql_data`~~ | ~~/var/lib/mysql~~ | 旧栈内 MySQL 数据目录 | **已移出**：元数据现在在 `docker/common/data/mysql`；旧目录的处置见「数据搬迁」 |
| ~~`./ragflow_minio_data`~~ | ~~/data~~ | 旧栈内 MinIO 对象数据 | **已移出**：对象现在在本栈实例的 `./data/rustfs`；旧目录的处置见「数据搬迁」 |

`gotenberg` 是唯一没有挂载的常驻服务：它只做进程内转换，无持久化状态，重启不丢数据，也不需要备份。

## 验证

```bash
# 1) 配置解析（不启动任何容器；RAGFLOW_MYSQL_PASSWORD 是必需键，所以要带上本目录 .env）
docker compose --env-file docker/ragflow/.env --env-file ./.env \
  -f docker/ragflow/docker-compose.yml config

# 2) 起栈（顶层必须先起，且 FENIX_FEATURE_MYSQL 已打开；对象存储是本栈自带，不需要 FENIX_FEATURE_S3）
docker compose -f docker/ragflow/docker-compose.yml up -d
docker compose -f docker/ragflow/docker-compose.yml ps -a
# 期望：两个初始化服务 Exited (0)、ragflow / ragflow-rustfs running、ragflow-redis / infinity healthy
# （-a 才会显示已退出的初始化容器）；失败时先看它们的日志——判定文案就在里面
docker compose -f docker/ragflow/docker-compose.yml logs ragflow-mysql-init ragflow-s3-init

# 3) 宿主回环端口（改过端口键就用改后的值）
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/            # 期望 200（Web UI）
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19380/api/v1/system/healthz   # 期望 2xx
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3200/health       # 期望 200（Gotenberg）

# 4) 网络成员与名字解析（保留名只应解析到共享实例那一处；本栈实例在项目网络里）
docker network inspect fenix-server --format '{{range .Containers}}{{.Name}} {{end}}'
docker compose -f docker/ragflow/docker-compose.yml exec ragflow getent hosts mysql ragflow-redis ragflow-rustfs

# 5) 若日后要评估改用共享 redis：先判定它是否满足 RAGFlow 的两条硬要求（有鉴权、有匹配的内存策略）
docker compose -f docker/ragflow/docker-compose.yml exec ragflow-redis redis-cli -a "$RAGFLOW_REDIS_PASSWORD" INFO server | grep -E 'redis_version|valkey_version'
# 栈内实例：期望 maxmemory=268435456、policy=allkeys-lru
docker compose -f docker/ragflow/docker-compose.yml exec ragflow-redis redis-cli -a "$RAGFLOW_REDIS_PASSWORD" CONFIG GET maxmemory maxmemory-policy
# 共享实例（属顶层项目）：期望 maxmemory=0 → 结论仍是不换（没有可淘汰策略，RAGFlow 的内存上限也就无处施加）
docker compose -f docker-compose.yml exec redis redis-cli CONFIG GET maxmemory maxmemory-policy
```

第 3 步的 `/api/v1/system/healthz` 是 knowledge 模块声明的探活路径（模块的 `dependencyServices.ragflow.healthCheck`，
与启动期 `checkRagFlowHealth()` 同一处）。若它返回 401/404 而容器本身正常，说明该镜像版本的探活路径与模块声明不一致——
记录下来并核对模块声明，不要为了让它变绿去改模块或改本编排。仓库里 2026-09-30 的现场记录
（`docs/operations/bug-fixes-2026-09-30.md`）在同一入口上核到版本 `v0.26.0`、健康接口返回 `ok`，可作对照。

端到端连通性以主服务侧为准：容器形态下 `RAGFLOW_API_URL=http://ragflow:9380` 且
`GOTENBERG_URL=http://gotenberg:3000`，然后在知识库页面做一次检索/自检、再打开一个 Office 文档的预览
（预览链路是 Gotenberg 优先、LibreOffice CLI 兜底，见 `packages/resources/knowledge/src/server/routes/web/knowledge-resource-preview.ts`）；
能连上但检索失败通常是 `RAGFLOW_API_KEY` 没填或该 key 不属于当前实例。

## 升级

1. 备份：本目录的 `./data/rustfs`（**本栈自带实例的对象数据**）、`./ragflow_data`、`./ragflow_logs`、
   `./ragflow_redis_data`、`./ragflow_infinity_data`、`infinity_conf.toml`，以及共享实例侧的 `docker/common/data/mysql`
   （整目录停服后拷贝）。
2. 改 `docker-compose.yml` 的 `image:` 行为目标版本——**镜像 tag 一律固定版本写进文件**，不用 `latest`、不做环境变量插值。
   当前固定情况：

   | 服务 | 当前 tag | 说明 |
   | --- | --- | --- |
   | `ragflow` | `infiniflow/ragflow:v0.26.0` | 精确版本；`ragflow-s3-init` 同镜像（初始化用的就是它自带的 minio 客户端） |
   | `ragflow-mysql-init` | `mysql:8.4.5` | 与共享实例同版本（客户端与服务端一致） |
   | `infinity` | `infiniflow/infinity:v0.7.0` | 精确版本；须与 `infinity_conf.toml` 的 `version` 同步改 |
   | `ragflow-redis` | `valkey/valkey:8` | **浮动 tag**：锁大版本、跟随 8.x 补丁版本更新，不等于定版 |
   | `ragflow-rustfs` | `rustfs/rustfs:1.0.1` | 精确版本；与 `docker/common/` 的共享实例同版本，便于两处对照排障 |
   | `gotenberg` | `gotenberg/gotenberg:8` | **浮动 tag**：锁大版本 8（沿用并入前的取值），同样不等于定版 |

   已随共享化退役的镜像（不再由本目录引用）：`mysql:8.0.39`（栈内实例）、`pgsty/minio:RELEASE.2026-03-25T00-00-00Z`（栈内对象存储）。
   后者被替换为栈内 `rustfs/rustfs:1.0.1`（本栈自带实例，见「本栈自带的 rustfs」），其镜像仍会在「数据搬迁」里
   临时用到一次，那之后再从本机清理。
3. `docker compose -f docker/ragflow/docker-compose.yml up -d`，再按「验证」复核。升级 RAGFlow 镜像时，
   它的 schema 迁移（`tools/scripts/mysql_migration.py`）在容器启动时自动跑在共享实例上。
4. 回滚：把 `image:` 行改回旧版本再 `up -d`。数据库 schema 与 Infinity 索引由新版本启动时迁移/重建，
   **跨版本回滚不保证向后兼容**——演练与回滚都以第 1 步的备份为前提。回滚到共享化之前的编排时，
   还要把栈内 MySQL / MinIO 的数据目录一并装回去（它们未被删除，见「数据搬迁」）。

两个浮动 tag 的收敛办法（本次不动，属独立变更）：在运行中的容器里取到真实补丁版本
（`docker compose -f docker/ragflow/docker-compose.yml exec ragflow-redis valkey-server --version`；
`docker compose -f docker/ragflow/docker-compose.yml exec gotenberg gotenberg --version`），把 tag 值改成该精确版本。

## 排障

| 症状 | 排查方向 |
| --- | --- |
| `network fenix-server ... could not be found` | 顶层项目没起：先 `./docker/deploy.sh up` |
| `ragflow-mysql-init` 报「共享 MySQL 在 300 秒内不可用」 | 看它给出的两条分支：`root 认证失败` → 根 `.env` 的 `MYSQL_ROOT_PASSWORD` 与实例不一致；`连不上实例` → `FENIX_FEATURE_MYSQL` 是否为 true、顶层项目是否已起、本容器是否在 `fenix-server` 上 |
| `ragflow-mysql-init` 报「root 权限不足」 | 实例被加固过：认证过了但 root 不允许建库/授权。需要实例管理员放权（本栈不会改用别的账号绕过） |
| `ragflow-s3-init` 报凭据被拒（`AccessDenied` / `SignatureDoesNotMatch`） | 本目录 `.env` 的 `RAGFLOW_S3_ACCESS_KEY` / `RAGFLOW_S3_SECRET_KEY` 必须与 `ragflow-rustfs` 启动时用的同值（同一对键同时注入两侧，改一处即可，改完 `up -d` 重建 `ragflow-rustfs`）；签名错误还要看两台机器时钟是否漂移 |
| `ragflow-s3-init` 报「服务端没有实现这个 S3 API」 | 该版本 rustfs 与 RAGFlow 的 minio 客户端不兼容：换对象存储实现或版本，别在编排里绕过 |
| `ragflow-s3-init` 报「本栈对象存储在 60 秒内不可用」 | `ragflow-rustfs` 没起来或健康检查未过：`docker compose -f docker/ragflow/docker-compose.yml ps ragflow-rustfs` 看状态、`logs ragflow-rustfs` 看它自己的报错；本地若是首次拉镜像，慢的通常是拉取而不是实例 |
| `ragflow` 起不来、日志里 access denied（MySQL） | 本栈账号口令被改过且没重跑初始化：`docker compose -f docker/ragflow/docker-compose.yml up -d ragflow-mysql-init` 重跑一次即把口令同步成 `.env` 的值 |
| `ragflow` 起不来、日志里 Redis 认证错误 | 栈内 Valkey 口令不一致：`RAGFLOW_REDIS_PASSWORD` 同时用于 `ragflow-redis` 的 `--requirepass` 与 `ragflow` 的 `REDIS_PASSWORD`，必须同值；Valkey 从命令行取口令，改完 `up -d` 即生效 |
| `getent hosts redis` 返回了共享实例的地址 | 保留名解析歧义：确认 `ragflow` 的 `REDIS_HOST` 是 `ragflow-redis` 而不是 `redis`（本目录编排已是后者） |
| `address already in use` | 18080 / 19380 / 3200 被占：改 `.env` 的端口键，或停掉占用方。注意 `docker/workflow/` 的宿主诊断入口默认也是 `127.0.0.1:18080`（其 `.env.example` 的 `WEB_LISTEN_ADDR`）——同机同时启用两栈时必须错开 |
| 主服务报连不上 RAGFlow | 容器形态填的是 `http://ragflow:9380` 吗（不是 `localhost` / `127.0.0.1`）；`ragflow` 容器是否在 `fenix-server` 里 |
| Office 文档预览/转换失败 | 容器形态的 `GOTENBERG_URL` 必须是 `http://gotenberg:3000`（填宿主回环的 3200 会指向容器自己）；`gotenberg` 是否在 `fenix-server` 里、宿主侧 `curl http://127.0.0.1:3200/health` 是否 200。Gotenberg 不可用时调用方回退 LibreOffice CLI，只有宿主没装 CLI 才真正不可用 |
| 文档能上传但检索/预览读不到内容 | 对象没在本栈实例里：先看 `ragflow-s3-init` 日志（实测 region 与探测结论）；再确认该知识库 / 目录对应的桶在不在实例上（多桶模式下桶名 = `kb_id` / `parent_id`，一个都不能少）；搬迁只看对象数不够，还要看桶名是否逐字相同。**不要**为了「修好」它设回 `MINIO_BUCKET`——那会把键布局改成 `<逻辑桶>/<对象名>`，已有对象反而全部读不到（见「多桶模式与本栈的键布局」的警告） |
| 健康检查长时间不通过 | 栈内两个辅助服务都有 healthcheck，`ragflow` 依赖它们 healthy；看 `docker compose -f docker/ragflow/docker-compose.yml logs ragflow-redis infinity` |
| 知识库检索报未配置 | `RAGFLOW_API_KEY` 为空：在 Web UI 生成 key 后写进根 `.env` 并重启主服务 |

## 需要 common 配合的点（本目录无法自行解决）

1. ~~**S3 凭据只有全实例一对**~~：**本栈已自行解决**——对象存储改为自带实例（见「本栈自带的 rustfs」），
   共享实例那套「全实例一对凭据」的代价不再由本栈承担。保留这条记录是为了说明当时的判断链：在共享实例上，
   「按消费方的桶策略」与多桶模式（桶名是运行期 UUID、实例侧列不出本栈有哪些桶）本来就无法同时成立，
   策略只能写成通配、等于没有隔离。因此当时的结论是「先定桶布局，再定策略形态」；最终的用户裁定是
   **把实例也分开**，于是布局保持多桶（不重打键）、隔离由实例边界提供。
   若将来要把本栈并回共享实例，要一并处理的前提就在这里：先拿到前缀级策略或多桶可枚举的桶治理。
2. **MySQL 服务器端参数**：`max_connections`（镜像默认 151）与 `max_allowed_packet`（默认值）在共享实例上对多栈并发偏低，
   多栈同时压库时需要调（本栈 RAGFlow 的客户端连接池声明为 900）。
3. **redis 若要被消费方共用**：需要 common 提供鉴权（`requirepass` 或 ACL）与可控的 `maxmemory` / 淘汰策略；
   现状下无鉴权实例对本栈不可用（见「共享 Redis」第 1 条）。

## 事实来源

- 共享实例定义与约束：`docker/common/docker-compose.yml`、`docs/operations/docker-topology.md`（§3 网络分层、§5 共享对象存储与 ragflow 特例、§5.1 共享基础设施、§6 依赖目录契约、§8 env 规范、§13 全局不变量）。
- 一次性初始化服务的形态先例：`docker/workflow/docker-compose.yml` + `init-mysql.sh`、`docker/litellm/docker-compose.yml` + `init-db.sh`。
- RAGFlow v0.26.0 的配置与客户端行为（本目录的判定依据，均为上游文件）：`docker/service_conf.yaml.template`
  （`minio.bucket` / `redis.db: 1` / `${VAR:-default}` 占位）、`docker/entrypoint.sh`（模板渲染循环）、
  `rag/utils/minio_conn.py`（桶名配置与 `use_prefix_path`、`put()` 里自建桶那句、`health()`）、`rag/utils/redis_conn.py`（valkey 客户端与命令面）、
  `api/db/services/file_service.py` 与 `api/db/services/file2document_service.py`（逻辑桶 = `kb_id` / `file.parent_id`）、
  `pyproject.toml`（`minio==7.2.4`、`valkey==6.0.2`、`mysql-connector-python>=9`）、`Dockerfile`（`VIRTUAL_ENV` / `PATH`）。
- minio-py 7.2.4 的寻址与 region 逻辑：`minio/helpers.py` 的 `_virtual_style_flag` 与 `BaseURL.build`、`minio/api.py` 的 `_get_region`。
- 对象存储实现的实现事实：`rustfs/rustfs:1.0.1` 镜像（`/usr/bin/rustfs` 内含 `GetBucketLocation`、`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`、`path_style`、`/health/ready`；镜像自带 `curl`）——本栈自带实例与 `docker/common/` 的共享实例用的是同一个镜像 tag。
- 本仓数据与备份口径：`docs/operations/backup-and-restore.md`、`docs/operations/deployment.md`。
