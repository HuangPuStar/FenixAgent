# Workflow V2 Docker 部署

上游仓库：[KonghaYao/workflow-studio](https://github.com/KonghaYao/workflow-studio)。核对日期：2026-10-14；本次交付标签 `sha-63fd6f8` 对应 `63fd6f8dae1697c7414fe26b41271155adfff788`（取自镜像 label `org.opencontainers.image.revision`；上一版基线是 `cd796ef91eae2fd77989eef868874104f6933b37`）。

这里部署的是 **Workflow V2 的独立上游服务**，不是本仓库旧自研 workflow engine。平台镜像不会包含上游；必须分别交付上游后端 / 画布与 FenixAgent。旧工作流定义不会自动导入 V2。

## 文件与边界

| 文件 | 用途 |
| --- | --- |
| `docker-compose.yml` | 唯一独立编排文件：声明本栈的 13 个服务，其中四个（`assets-init` / `atlas-init` / `mysql-init` / `s3-init`）是执行完即退出的一次性服务；web 用画布子路径变体镜像（产物在镜像里，不再挂载 `dist`）与共享网络；RCS 接入配置直接写在文件头部注释 |
| `.env.example` | 本编排**唯一**的环境模板：① 编排参数（镜像 tag、宿主诊断端口）② 应用配置叠加层（作为 `coze-server` 的 `env_file`）。共享键（`MYSQL_*` / `RUSTFS_*`）不写在这里，见 §3 |
| `init-mysql.sh` | `mysql-init` 的执行脚本（幂等、可重跑）：等共享实例可用 → 建库建号 → 应用账号自检 → 应用上游 `schema.sql`（Atlas 收敛拆到 `atlas-init`，见 §4）。compose 以只读方式挂到容器 `/init/init-mysql.sh`，用 `/bin/sh` 解释执行（不依赖宿主的可执行位） |
| `init-s3.sh` | `s3-init` 的执行脚本（幂等、可重跑）：等共享 rustfs 可用 → 幂等建桶（`opencoze` / `milvus`）→ 用同一份凭据自检 → 播种画布图标。挂载与执行方式同 `init-mysql.sh` |
| `nginx.conf` | 唯一出口的 API / 静态代理，以及只读签名存储代理；覆盖镜像的 `/etc/nginx/conf.d/default.conf`（镜像自带 nginx 主配置），补上镜像不提供的画布子路径映射（`/workflow-canvas/<rest>` 剥离前缀 + SPA 回退）与 `client_max_body_size`（上传 / 画布产物需要，见文件内注释） |

运行期还会生成 `docker/workflow/assets/`（`assets-init` 展开的初始化资产）与 `docker/workflow/data/`（栈内服务数据），两者都不进版本控制，见 §2.1 与 §8。

**交付清单**：把本目录交付到目标机时，`init-mysql.sh` 与 `init-s3.sh` 必须一起带走——它们是各自初始化服务的 entrypoint，
缺任一个时对应容器会因为 `create_host_path: false` 直接报错（而不是被 docker 静默建成一个同名目录然后以退出码 127 失败）。

本目录直接声明全部 13 个服务（含四个一次性服务 `assets-init` / `atlas-init` / `mysql-init` / `s3-init`），只有一个普通 Compose YAML，不使用 `extends`、`include`、`x-upstream`、anchor 或 `!override`。

**共享基础设施不在本目录**：MySQL 与对象存储都由主服务项目提供（`docker/common/`；dev 是仓库根 `docker-compose.yml`，生产是 `docker/main/docker-compose.yml`），开关分别是 `FENIX_FEATURE_MYSQL` 与 `FENIX_FEATURE_S3`（镜像 tag、端口、数据目录见 `docker/common/docker-compose.yml`）。Elasticsearch、Redis、etcd、Milvus、NSQ 仍是**本栈私有**的服务，留在本目录，数据落在本目录的 `docker/workflow/data/`（见 §8）。代价与理由：

- 收益：同一台机器上多个栈共用一套 MySQL 与一套对象存储，不再每个栈一套；它们的落点随交付面固定在 `docker/common/data/mysql` 与 `docker/common/data/rustfs`。
- 代价一：本目录**不再是自包含的部署单元**——它依赖主服务项目先启动（共享实例在另一个 Compose 项目里，跨项目没有 `depends_on` 可表达）。独立部署本目录时也必须带上 `docker/common/`。
- 代价二：`coze-server`、`coze-web`、`milvus`、`mysql-init`、`s3-init` 必须接入 external 网络 `fenix-server` 才能按服务名解析共享实例，因此这些容器也暴露在该网络里。
- 代价三：共享实例里**属于本栈的库与账号**、以及上游 schema 的初始化，改由本目录的一次性服务 `mysql-init` 承担（原先写在 mysql 容器的启动脚本里）；**属于本栈的桶与图标播种**改由 `s3-init` 承担（原先写在 minio 容器的 entrypoint 里）。两者的成败分别决定 `coze-server` 是否启动。库与账号由它幂等创建，**不依赖共享实例的 `MYSQL_DATABASE` / `MYSQL_USER`**（那两个键只在实例的数据目录首次初始化时生效，对已经存在的实例无效），也不需要运维手敲 SQL。
- 指向键（`MYSQL_HOST` / `MYSQL_PORT` / `MINIO_ENDPOINT` / `MINIO_API_HOST` / `MINIO_AK` / `MINIO_SK` 等）**由本编排在 `coze-server` 上用 `environment` 显式注入**（Compose 里 `environment` 优先于 `env_file`），本目录 `.env` 改它们不会生效；共享键取值来自主服务 env。容器内地址仍是 `mysql:3306` / `rustfs:9000`，因为服务名与端口在 common 里保持原值。

初始化资产（MySQL schema、Atlas HCL、ES 四件、etcd 配置、画布图标）随上游 server 镜像交付、由一次性服务 `assets-init` 展开到本目录 `assets/`（见 §2.1）；应用配置由本目录唯一一份 `.env` 提供（见 §3）。启动时**不读取上游 Compose 文件、也不需要上游源码目录**。本文件的服务配置以文首基线为依据，上游升级时显式审查同步，不自动继承变化。

拓扑：

```text
浏览器 → FenixAgent 同源 HTTPS 入口
           ├─ /web/workflow-v2/*       会话认证 / 组织与归属校验
           ├─ /workflow-canvas/bff/*   票据 / 参数注入 → workflow-upstream:80 → 上游 API
           └─ /workflow-canvas/*       静态反代 → 上游 Web / 存储

external 网络 fenix-server：
  平台 rcs ←→ 唯一出口 coze-web
                ├─ workflow-upstream：API / 画布静态入口
                └─ workflow-storage：只读签名存储入口 → rustfs:9000
  共享基础设施：mysql / rustfs（主服务项目 docker/common/ 提供）
  消费方：coze-server（运行期读写库与桶）、milvus（读写自己的桶）、
          assets-init / atlas-init / mysql-init / s3-init（一次性）

Compose 自动创建的项目默认网络：
  coze-web → coze-server → Redis / Elasticsearch / Milvus / etcd / NSQ
```

上游依赖原样复用，**本编排没有消除其权限或初始化风险**：部分基础服务有 privileged 配置，MySQL 的 schema 初始化由 `mysql-init`（`schema.sql`）与 `atlas-init`（固定版本 Atlas 镜像）两个一次性服务完成。应在可信主机运行，上线前审核固定版本配置并备份已有数据库；不要将所有上游端口暴露公网。共享 MySQL 只经 `fenix-server` 与回环端口可达、**没有认证**（它由 common 提供），不得发布到公网；栈内服务（Elasticsearch / Redis 等）留在项目默认网络里，也不发布宿主端口。内部不声明自定义网络，使用 Compose 自动创建的项目默认 bridge；不设置 Docker `internal: true`，避免阻断节点调用外部模型等出站流量。

## 1. 前置条件

- Docker Engine 与 Docker Compose v2（主服务项目含 `include`，需 ≥ 2.20）；使用标准 Compose 配置，不要求扩展 YAML 标签。
- **共享 MySQL 先就绪（本目录不再自足）**：
  ```bash
  ./docker/deploy.sh up          # 主服务项目 + 已启用依赖；使用共享库前先在 docker/deploy.env 打开 FENIX_FEATURE_MYSQL
  # 或不起平台主服务、只起共享服务：
  docker compose -f docker-compose.yml --profile mysql up -d                          # dev（仓库根编排）
  docker compose -f docker/main/docker-compose.yml --profile mysql up -d   # 生产（自动读 docker/main/.env）
  ```
  `mysql` 是主服务项目（dev 是仓库根 `docker-compose.yml`，生产是 `docker/main/docker-compose.yml`）里的服务名；它不在时本目录的初始化服务会在 300 秒后明确报错退出。
- **共享对象存储先就绪（同一个主服务项目，开关是 `FENIX_FEATURE_S3`）**：本栈已不再自带对象存储，`coze-server` 与 `milvus` 都读共享 `rustfs`。判定：
  ```bash
  docker compose -f docker-compose.yml --profile s3 up -d   # dev（仓库根编排）：只起共享对象存储（主服务项目未起时）
  docker compose -f docker/main/docker-compose.yml --profile s3 up -d   # 生产（自动读 docker/main/.env）
  docker compose -f docker-compose.yml ps rustfs            # dev（仓库根编排）；期望 healthy
  docker compose -f docker/main/docker-compose.yml ps rustfs            # 生产（自动读 docker/main/.env）
  ```
  `rustfs` 同上，是主服务项目的服务名；它不在时 `s3-init` 会在 300 秒后明确报错退出，`coze-server` 与 `milvus` 因此都不启动。**顺带注意**：`coze-web` 的 nginx 在**启动时**解析 `rustfs`（不是每次请求），共享实例没起时它会直接以 `host not found in upstream "rustfs"` 起不来；共享实例重建（换 IP）后也要重启 `coze-web`，见 §7。
- **Elasticsearch 的宿主前置条件**（ES 仍是本目录的服务、数据在本目录 `./data/elasticsearch`；不满足时 ES 容器会反复重启，`coze-server` 也就起不来——只留在 compose 里看不出来）：
  - `vm.max_map_count` ≥ 262144（ES 建索引的硬要求）。判定：`sysctl -n vm.max_map_count`；设置：`sudo sysctl -w vm.max_map_count=262144`，并写入 `/etc/sysctl.d/99-elasticsearch.conf` 持久化。
  - 宿主内存：ES 单节点建议 ≥ 2GB 可用（容器不加内存上限时堆大小由镜像自行推导，本编排不设 `ES_JAVA_OPTS`）；**可用内存不足时不要指望它自动降级**，先扩内存或去掉同时运行的大栈。
  - 宿主磁盘：`docker/workflow/data/elasticsearch` 所在分区留出足够空间。ES 默认磁盘水位 85% 会让分片只读、上游写入直接失败；`assets-init` 展开的 `volumes/elasticsearch/elasticsearch.yml` 把水位抬到 99%，换来的只是「更晚才拒绝写入」，磁盘仍然必须监控。
- 宿主可分配端口：`MYSQL_HOST_PORT`（默认 3306，共享 MySQL 的宿主端口，只绑回环）不冲突即可。共享 rustfs 默认**不发布宿主端口**，本栈不需要它。
- 主机有资源容纳上游完整依赖栈；具体容量应依据实际负载评估，而不是按单个 Web 服务估算。
- 已有可用的 FenixAgent、PostgreSQL、控制台账号与组织。平台应包含 `71d3e4f4b` 的 V2 接入及后续必要修复。
- 可以访问 GHCR 与基础镜像源。镜像拉取失败时先核对 GitHub Actions 的发布结果、标签、包可见性和主机架构。

上游发布 workflow 生成三个镜像，**同一 commit 同一 tag**：

```text
ghcr.io/konghayao/workflow-studio-server:<tag>        # coze-server（Go 服务）；初始化资产也在它里面（/app/upstream-assets，见 §2.1）
ghcr.io/konghayao/workflow-studio-web:<tag>           # 根路径部署的 Web（本编排不用）
ghcr.io/konghayao/workflow-studio-web-canvas:<tag>    # 画布子路径变体，本编排的 coze-web
```

`-web-canvas` 与 `-web` 同源码，只差构建参数 `WORKFLOW_CANVAS_BASE=/workflow-canvas/`（同时决定资源前缀与 router basename）。**它的契约是**：镜像内 nginx 只在根路径 `/` 提供 SPA、`dist` 未下沉，也没有 `/workflow-canvas/` location、不做 SPA 回退——`/workflow-canvas/<rest>` 的前缀剥离与 SPA 回退由消费方负责（本栈见 §2.2）。两个 web 变体都只是 nginx + 静态产物，镜像自带 nginx 主配置；本目录只用 `nginx.conf` 覆盖它的站点配置 `/etc/nginx/conf.d/default.conf`。

模板标签 `sha-63fd6f8` 对应本文核对的源码基线；镜像已在 GHCR 发布（2026-10-14 构建，已按 amd64 拉取并核对镜像内 `/app/upstream-assets` 与源码逐文件一致，未执行容器启动与生产联调）。生产升级应固定新版本，确认两侧契约与画布变体再切换，不直接追随 `latest`。

## 2. 上游交付面：镜像与初始化资产

### 2.1 初始化资产随 server 镜像交付

上游部署需要的六类初始化资产——MySQL `schema.sql`、Atlas HCL（`opencoze_latest_schema.hcl`）、Elasticsearch 四件（`elasticsearch.yml` / `analysis-smartcn.zip` / `setup_es.sh` / `es_index_schema/`）、etcd 配置、画布与插件图标（`volumes/minio/` 下的 `default_icon` / `official_plugin_icon`）——**已打进 `workflow-studio-server` 镜像**的 `/app/upstream-assets/docker/`，与二进制同 commit、同 tag。首次启动时由一次性服务 `assets-init` 展开到宿主的 `docker/workflow/assets/`，消费方（`atlas-init` / `mysql-init` / `s3-init` / `elasticsearch` / `etcd`）再按普通 bind 挂载读取，相对路径与原先挂上游源码目录时逐一对应。

- **为什么必须经这一跳**：Docker 不能把镜像内的路径直接挂进别的容器，而消费方要的是宿主上的真实文件。
- **为什么放 server 镜像而不新增制品**：资产与二进制同 commit、同 tag，天然对齐；该镜像本来就要拉取，不新增拉取面。代价是运行期镜像多约 6MB（`docker/volumes` 与 `docker/atlas` 合计约 6 MB / 144 个文件）。
- **镜像内不是源码目录的逐字节副本**：上游 `.dockerignore` 的 `**/README.md` 会把 `docker/atlas/README.md` 排除在外（源码有、镜像没有，所以是 144 而非 145 个文件）；该文件只是说明文档，部署不读取。
- **幂等与重跑口径**：`assets-init` 先清空 `./assets/` 顶层再整体拷贝（tag 变更不会残留上一版文件），并把展开来源写进 `./assets/.source`（形如 `workflow-studio@sha-63fd6f8`）。`./assets/` 是生成目录、不进版本控制，删掉可随时重建：

  ```bash
  docker compose -f docker/workflow/docker-compose.yml up -d --force-recreate assets-init
  ```

  需要连带重跑其它初始化服务时把服务名追加在同一行；`atlas-init` / `mysql-init` / `s3-init` 都是幂等的（见 §4）。
- **依赖链**：`mysql-init` / `s3-init` / `elasticsearch` / `etcd` 都等 `assets-init` 成功退出；`atlas-init` 等 `mysql-init` 成功退出（`coze-server` 等它们全部成功）。
- **tag 门槛**：`WORKFLOW_STUDIO_TAG` 不得低于「初始化资产随镜像交付」的首个发布——`sha-63fd6f8`（2026-10-14）。更早的 tag 里没有 `/app/upstream-assets`，`assets-init` 会当场报错并提示换 tag，下游服务因此都不启动，不会静默起半截栈。

### 2.2 画布以 `-web-canvas` 镜像交付（子路径契约）

画布产物不再由本机构建：`coze-web` 直接用上游发布的 `-web-canvas` 变体镜像（见 §1），构建期已注入 `WORKFLOW_CANVAS_BASE=/workflow-canvas/`。不再需要 Node / Rush，也不再需要 `make fe` 与 `frontend/apps/coze-studio/dist`。

**画布的子路径契约**（接错了就是白屏，别只改运行期 env）：

- 镜像内 nginx 只在**根路径** `/` 提供 SPA，`dist` 未下沉，镜像侧**没有** `/workflow-canvas/` location，也**不做** SPA 回退；
- 消费方必须把 `/workflow-canvas/<rest>` 剥离前缀后交给镜像（`<rest>` → 上游根路径），并自己负责 SPA 回退；
- 本栈这两件事有两层：平台静态反代（RCS `workflow-v2`）把 `/workflow-canvas/<rest>` 与 `/workflow-canvas/` 分别映射到上游 `<rest>` 与 `/`，非静态资源的 404 回退到上游根文档——浏览器侧因此只认 `/workflow-canvas/*`；本目录 `nginx.conf` 再补一条 `location /workflow-canvas/` 做同样的剥离与回退，兜住带前缀直达 `coze-web` 的形态（宿主诊断入口 `WEB_LISTEN_ADDR`、或前置代理未剥离时）。

校验只看 **basename**（**不要**用 `grep workflow-canvas`：源码里本有无关常量 `flow-workflow-canvas-dnd`，会假阳性）：

```bash
grep -ro 'basename:"[^"]*"' /usr/share/nginx/html/static/js    # 期望只有 basename:"/workflow-canvas"
```

在目标机上用运行中的容器执行同一条（`docker compose ... exec coze-web grep -ro ...`），它检查的是实际交付的那份产物。

## 3. 配置（唯一一份 .env）

```bash
cp docker/workflow/.env.example docker/workflow/.env   # 或 ./docker/deploy.sh init 物化（已存在则不覆盖）
chmod 600 docker/workflow/.env   # 应用配置可能含密钥（MODEL_API_KEY_* / PLUGIN_AES_*）
```

本文件是**唯一**的配置面，模板头部分了三节，改之前先分清：

| 面 | 键 | 说明 |
| --- | --- | --- |
| ① 编排参数 | `WORKFLOW_STUDIO_TAG` | 上游 server 与画布变体（`-web-canvas`）同 tag；不得低于「初始化资产随镜像交付」的首个发布（§2.1） |
| ① 编排参数 | `WEB_LISTEN_ADDR` | 宿主诊断入口（只绑回环，默认 `127.0.0.1:18081`）。默认避让同机 ragflow 的调试发布 18080（`docker/ragflow/.env` 的 `RAGFLOW_WEB_PORT`），冲突时改这里 |
| ② 应用配置 | `LOG_LEVEL`、`MAX_REQUEST_BODY_SIZE`、注释态的注册 / embedding / `MODEL_*` / `PLUGIN_AES_*` | 作为 `coze-server` 的 `env_file` 传入，是**叠加层**：镜像内 `/app/.env` 已带上游全部默认值，这里只写要改的键 |
| ③ 共享键 | `MYSQL_*` / `RUSTFS_*` | **不写在本文件**（见下） |

- **叠加层语义**：写 `KEY=`（空值）等于把该键覆盖为空，不是「保持默认」；不确定就整行注释掉。模型 / embedding 配置按实际节点能力填，画布能打开不代表节点可执行。
- **基础设施指向不改这里**：`MYSQL_HOST` / `MYSQL_DSN` / `MINIO_*` / `REDIS_ADDR` / `ES_ADDR` / `MILVUS_ADDR` / `MQ_NAME_SERVER` / `STORAGE_BUCKET` 等由 `docker-compose.yml` 的 `environment` 注入（Compose 里 `environment` 优先于 `env_file`），**改本文件不会生效**——这样「这个栈连到哪里」在评审时集中可见，也不会被误编辑指向别处。
- **共享键只在主服务 env**（生产 `docker/main/.env`、dev 仓库根 `.env`）：`MYSQL_ROOT_PASSWORD` / `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD` 与 `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` / `RUSTFS_REGION`。本编排用 `${...}` 插值引用（缺省值与 `docker/common/docker-compose.yml` 一致，只服务本地）；它们在两个 Compose 项目之间必须同值，而 `docker/deploy.sh` 只导出主服务 env。
- **注册开关默认放开**：平台首次引导需要向上游自助注册专用账号（§5）；上游关闭自助注册时须先手工创建匹配账号。
- 本文件含密钥时不提交、不打印完整内容、不放入普通备份包。

## 4. 启动

以下命令均在 **FenixAgent 仓库根目录**执行。先起共享基础设施，再起本目录（**顺序不变量**：共享 mysql 与 rustfs 都在主服务项目里，本目录只引用它们所在的网络）：

```bash
# 1) 主服务项目：共享 MySQL + 共享 rustfs（按需打开两个开关；脚本会带对应 profile）
./docker/deploy.sh up
#   或只起共享服务（`docker-compose.yml` 指仓库根那份）：
#   docker compose -f docker-compose.yml --profile mysql --profile s3 up -d   # dev（仓库根编排）
#   docker compose -f docker/main/docker-compose.yml --profile mysql --profile s3 up -d   # 生产（自动读 docker/main/.env）

# 2) 确认共享实例可用（本目录的两个初始化服务同样依赖它们）
docker compose -f docker-compose.yml exec mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e 'SELECT 1'   # dev（仓库根编排）
docker compose -f docker/main/docker-compose.yml exec mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e 'SELECT 1'   # 生产（自动读 docker/main/.env）
docker compose -f docker-compose.yml ps rustfs   # dev（仓库根编排）；期望 healthy；本栈 s3-init 就等这个健康检查
docker compose -f docker/main/docker-compose.yml ps rustfs   # 生产（自动读 docker/main/.env）
```

创建共享网络（主服务项目已起时它必然存在；只有手工起本目录、且已用别的方式提供共享实例时才需要）：

```bash
docker network inspect fenix-server >/dev/null 2>&1 \
  || docker network create fenix-server
```

校验、拉取、启动（compose 自动读本目录 `.env`，不再需要任何 `--env-file`，也不再有指向上游源码目录的变量）：

```bash
docker compose -f docker/workflow/docker-compose.yml config --quiet
docker compose -f docker/workflow/docker-compose.yml pull
docker compose -f docker/workflow/docker-compose.yml up -d
docker compose -f docker/workflow/docker-compose.yml ps
```

手工独立启动（不经 `docker/deploy.sh`）且共享键不在 shell 环境时，叠加主服务 env：`docker compose --env-file docker/workflow/.env --env-file docker/main/.env -f docker/workflow/docker-compose.yml up -d`（后者优先；**指定 `--env-file` 后 compose 不再自动读项目目录的 `.env`**，所以两份都要给）。

使用 `config --quiet`，不要把展开后的完整配置输出到日志，它会包含 `.env` 与主服务 env 中的敏感值。拉取失败或初始化失败不得跳过；先查看失败服务日志，再继续平台接入。

`up -d` 会先跑四个一次性服务，`coze-server` 等它们都成功退出才启动（`depends_on: service_completed_successfully`）；`milvus` 只等 `s3-init`：

| 服务 | 做什么 | 失败时的表现 |
| --- | --- | --- |
| `assets-init` | 把镜像内 `/app/upstream-assets/docker/` 的初始化资产展开到宿主 `./assets/`（先清空再拷贝，写 `.source` 记录来源 tag），见 §2.1 | 非零退出则 `mysql-init` / `s3-init` / `elasticsearch` / `etcd` 都不启动；tag 早于带资产的发布时当场给出换 tag 提示 |
| `atlas-init` | 用固定版本镜像 `arigaio/atlas:1.3.3-community` 把 `./assets/atlas/opencoze_latest_schema.hcl` 收敛到共享 MySQL（`--exclude atlas_schema_revisions,table_*`，与上游逐字一致） | 非零退出则 `coze-server` 不启动；失败看它的日志（DSN 连接、HCL 差异） |
| `mysql-init` | ① 等共享 MySQL 可用并可认证 → ② 幂等创建本栈的库与账号（`CREATE DATABASE IF NOT EXISTS` / `CREATE USER IF NOT EXISTS` / `GRANT`）→ ③ 用应用账号自检口令 → ④ 应用 `./assets/volumes/mysql/schema.sql`（阶段编号与 `init-mysql.sh` 的日志前缀一一对应；Atlas 收敛见上一行） | 任一步失败即以非零码退出，`atlas-init` 与 `coze-server` 都不会启动 |
| `s3-init` | ① 等共享 rustfs 通过 `/health` → ② 幂等创建两个桶（`opencoze` / `milvus`，`PUT /<bucket>` 的 200 与 409 都算通过）→ ③ 用同一份凭据读桶自检 → ④ 把 `./assets/volumes/minio/` 下的画布 / 插件图标播种进 `opencoze`（幂等覆盖写；**失败只告警，不阻塞**，理由见脚本头「例外」一段） | ①②③ 任一步失败即以非零码退出，`coze-server` 与 `milvus` 都不会启动；④ 失败只影响图标，栈照常可用，按日志末尾给出的命令重跑 `s3-init` 即可 |

幂等（重跑即空操作，不覆盖既有数据）：`CREATE DATABASE` / `CREATE USER` 都用 `IF NOT EXISTS`；**账号已存在时不会改它的口令**，所以第 ③ 步用应用账号自检——口令与配置不一致时当场失败，报错直接指向 `MYSQL_PASSWORD`（而不是拖到 `coze-server` 连不上才查）。`s3-init` 同理：建桶命中已存在的桶时服务端回 409，脚本当成功处理，不进桶里任何对象；图标播种是覆盖写，同一份源文件重传结果不变。`mysql-init` / `s3-init` / `atlas-init` 都只跟共享实例通信，因此**只接 `fenix-server`**，不在项目默认网络里。

关于 `s3-init` 为什么用 `rustfs/rustfs:1.0.1` 这个**服务端**镜像当客户端：建桶需要一个 S3 客户端，而仓库里唯一自带 `mc` 的镜像是 MinIO——用它等于把要收敛掉的制品又引回编排里，且「全仓只剩一套对象存储」的检索口径立刻失真。该镜像是 `docker/common/` 的 rustfs 同款 tag（仓库已有镜像，不新增来源），镜像内的 curl 8.22.0 原生支持 `--aws-sigv4`（AWS SigV4），足以完成「建桶 + 上传对象」。**它只覆盖本栈需要的三步**；需要 `mc` 那类完整客户端能力（跨实例迁移、策略管理）时不在这里扩，另议（见 §8）。

关于 `depends_on`：共享 MySQL / rustfs 属于另一个 Compose 项目，**跨项目无法声明健康依赖**（写 `depends_on: mysql` 或 `rustfs` 会被 Compose 判为 `depends on undefined service` 直接拒绝），所以这里的就绪判定是各自初始化脚本里的「带超时的重试 + 明确诊断」，语义上等价于 `service_healthy`，只是判定放在容器里、报错文本由本目录自己控制。脚本**只读挂载 + 显式覆盖 entrypoint**：镜像自带的 entrypoint 会把参数当 mysqld / rustfs 启动参数劫持掉，不覆盖就直接走错路径。

默认宿主诊断入口为 `http://127.0.0.1:18081`（`WEB_LISTEN_ADDR` 提供），平台容器实际访问 `http://workflow-upstream:80`。端口只有这一条映射；容器内部的服务名与端口保持上游默认（如 `coze-server:8888`），不额外发布。

## 5. 接入 FenixAgent

### 平台配置与迁移

默认 `deploy/assembly/ce.json` 已将 `workflow-v2` 放进 `resources`，Web contribution 的导航 ID 仍为 `workflow`。自定义装配同样核对两者；不要把 Web 导航 ID 改成 `workflow-v2`。

在平台环境（生产为 `docker/main/.env`、dev 为仓库根 `.env`）注入：

| 变量 | 要求 / 默认值 |
| --- | --- |
| `WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL` | **必填**，专用上游账号邮箱；经 `docker/deploy.sh` 部署时由它在缺失时**生成并固化**（按主机名派生、写入 `docker/main/.env` 后不再改动，见 `docs/operations/docker-topology.md` §9）。独立部署须自行填部署方可控的邮箱 |
| `WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD` | **必填密钥**，上游账号密码 |
| `WORKFLOW_V2_TICKET_SECRET` | **必填密钥**，建议至少 32 字节随机材料 |
| `WORKFLOW_V2_UPSTREAM_BASE_URL` | 文件头部注释要求设置为 `http://workflow-upstream:80` |
| `WORKFLOW_CANVAS_UPSTREAM_URL` | 文件头部注释要求设置为 `http://workflow-upstream:80` |
| `WORKFLOW_V2_IFRAME_CODE_TTL_SECONDS` | 默认 `60` |
| `WORKFLOW_V2_IFRAME_TICKET_TTL_SECONDS` | 默认 `900` |
| `WORKFLOW_V2_UPSTREAM_TIMEOUT_MS` | 默认 `10000` |
| `WORKFLOW_V2_NODE_WHITELIST` | 默认 `1,2,3,5,8,11,13,15,18,20,30,31,45,58`，数字类型许可集 |
| `WORKFLOW_V2_RECONCILE_INTERVAL_SECONDS` | 默认 `300`；`0` 禁用补偿对账，生产不建议关闭 |
| `WORKFLOW_V2_BFF_RATE_LIMIT_PER_MINUTE` | 默认 `1200`，调得过低会干扰调试轮询 |
| `WORKFLOW_V2_SESSION_RATE_LIMIT_PER_MINUTE` | 默认 `60` |
| `RCS_REDIS_URL` | 可选，仅共享上游登录会话与登录租约，不共享画布票据 |

模块变量以 `packages/resources/workflow-v2/fenix.module.ts` 为准，修改后重启生效；不要沿用旧文档中的 `WORKFLOW_V2_UPSTREAM_ACCOUNT_*` 拼写。密钥经 secret store 或受控环境文件注入，不能写在命令行示例、源码或日志中。

平台版本必须有 V2 后端与控制台构建产物，并执行完整 `drizzle/` 迁移链。相关迁移是 `0030_workflow-v2-init`、`0031_workflow-v2-audit-action-index` 与 `0032_workflow-v2-rename-upstream-identifiers`，不是在生产库手工抽取三段 SQL。

在已配置目标库的发布环境中执行 DDL，再执行数据迁移；不能误用本机开发 `.env`。容器迁移任务与应用应使用相同配置及文件卷，步骤见 `docs/operations/upgrade.md`。本目录不启动第二个 FenixAgent，也不接管平台数据库迁移。

### 平台容器接网

网络接入清单（判定标准与理由见 `docs/operations/docker-topology.md` §3）：

| 服务 | 网络 | 理由 |
| --- | --- | --- |
| `coze-web` | 项目默认网络 + `fenix-server`（`external: true`） | 唯一出口：平台容器按服务名访问上游 API 与存储入口；同时它要按服务名 `rustfs` 直连共享对象存储（存储虚拟主机） |
| `coze-server` | 项目默认网络 + `fenix-server` | 上游 `.env` 里的 `MYSQL_HOST=mysql` 指向共享实例，必须在该网络上按名解析；对象存储同样是共享的（`rustfs:9000`）；同时它仍要按名访问项目默认网络里的 `redis` / `elasticsearch` / `milvus` |
| `milvus` | 项目默认网络 + `fenix-server` | 它的对象存储从栈内 minio 改成了共享 `rustfs`，必须在该网络上按名解析；etcd / 自身仍在默认网络 |
| `mysql-init` | 仅 `fenix-server` | 只跟共享 MySQL 通信，不需要项目默认网络 |
| `s3-init` | 仅 `fenix-server` | 只跟共享 rustfs 通信，不需要项目默认网络 |
| 其余 6 个服务（`redis` / `elasticsearch` / `etcd` / `nsqlookupd` / `nsqd` / `nsqadmin`） | 项目默认网络 | 辅助服务，只被 `coze-server` / `coze-web` / `milvus` 访问，不接入主服务层 |

`coze-server` 接入 `fenix-server` 是这次上移的代价：该容器对共享网络里的 `postgres` / `redis` / `rustfs` / `mysql` 都可见。**没有更省的方案**——共享实例只在 `fenix-server` 上，而跨项目没有别的寻址方式（宿主回环端口在容器里不可用；改成 `host.docker.internal` 既要求每个服务加 `extra_hosts: host-gateway`，又违反「容器内地址写显式值」的规范）。

**RCS 所需环境与组网示例直接位于 `docker-compose.yml` 文件头部注释。** 按注释修改现有 RCS 的环境文件与编排：将 `rcs` 接入与其他编排一致的 external 网络 `fenix-server`，再通过原有 RCS 发布命令重建容器；若另有必需网络，由 RCS 部署方核对保留。仅修改环境文件不等于容器已加入网络。

本文件不启动、不替换、不自动修改 RCS。主编排固定的平台标签未必包含 V2，发布时须使用已核验的平台镜像；也不需要额外的 RCS overlay YAML。共享网络示例适用于同机 Docker；跨机器改成平台容器可达的内网 URL，存储签名地址也要可达。

**本目录与主服务项目必须同机。** 共享 MySQL 只在 `fenix-server` 与宿主回环端口上可达，跨机器时本目录的初始化服务与 `coze-server` 都解析不到它。需要把上游栈放到另一台机器时，先单独评审共享实例的暴露方式（内网地址 + 认证），不要只改 `docker-compose.yml` 里的地址。

若平台直接在宿主源码运行，可将两项 upstream URL 设置为 `http://127.0.0.1:18081`；签名存储入口 `workflow-storage` 只在上游容器网络内可解析，宿主侧有两条等效路径：把 `WORKFLOW_V2_STORAGE_UPSTREAM_URL` 也设为 `http://127.0.0.1:18081`（**推荐**：平台连接它，直链主机名只作 `Host` 头交给上游反代选站，签名不参与该校验，因此无需改宿主 DNS），或自行配置宿主可达的 DNS / 反代并保留正确 Host。两条路径都不得直接开放共享 rustfs。模板主要面向同机容器部署，容器内 `127.0.0.1` 不是上游或宿主。

### 存储同样通过唯一出口

`workflow-upstream` 与 `workflow-storage` 都是 **coze-web** 在 `fenix-server` 上的别名，不是共享 rustfs 的别名。API 代理将签名 URL 中的 `rustfs:9000` 替换为 `workflow-storage`，保留 `/opencoze/` 路径与查询签名；平台再将图片 URL 改写到同源 `/workflow-canvas/storage/*`。这三处是同一份地址契约，改名必须一起改：`coze-server` 的 `MINIO_API_HOST`、`nginx.conf` 的 `sub_filter`。

存储虚拟主机只允许 `/opencoze/` 下的 GET / HEAD，并向共享 rustfs 恢复签名使用的 `Host: rustfs:9000`；其他路径返回 404，Cookie 与 Authorization 不透传。不要直接使用上游默认的 `/local_storage/` 改写：它会让签名链接与 API 同 origin，当前平台图片改写无法将该形态转换成同源存储路径。上线必须验证签名图片实际加载，不能只确认网络与 nginx 配置解析通过。

### 反向代理与副本限制

- 浏览器只访问平台统一 HTTPS origin；完整保留 `/workflow-canvas/*` 路径转发到平台，BFF 不能直接到上游。**前缀剥离是网关侧的责任**：平台静态反代把 `/workflow-canvas/<rest>` 映射到上游 `<rest>`、`/workflow-canvas/` 映射到上游 `/`（画布镜像只在根路径提供 SPA）；若网关再前置一层反向代理，它同样不能把带前缀的路径直接透给上游。
- 网关不能缓存控制面 / BFF / session 响应，不能记录 Cookie、`X-Fenix-Workflow-Ticket` 或票据响应体。
- 不添加阻止同源 iframe 的 `X-Frame-Options: DENY` 或 `frame-ancestors 'none'`；宿主 `frame-src` 应允许 `'self'`。
- **当前工作流入口先使用单个平台进程。** 一次性 code、签发白名单、撤销记录仍在 `iframe-ticket.ts` 的进程内 Map；相同签名密钥与 Redis 不能解决跨副本票据校验。平台多副本时须将控制面与整条画布链固定到同一实例并专项验证，不能直接轮询分流。
- 平台重启后用户需要重新打开画布获得新票据。上游平台账号为专用账号，不供人工日常登录，避免踢掉服务会话。

## 6. 初始化与验收

先验收共享基础设施与初始化（不通过就不必往下走）：

```bash
# 1) 一次性服务是否成功退出：四个状态都必须是 Exited (0)，任一非 0 时 coze-server 不会启动
docker compose -f docker/workflow/docker-compose.yml ps -a assets-init atlas-init mysql-init s3-init
# 2) 它们的日志末行与失败原因（assets-init 报「资产已展开：N 个文件」；mysql-init 的库 / 账号 /
#    schema 四段各有前缀 ①②③④；s3-init 的就绪 / 建桶 / 自检 / 播种四段同样是 ①②③④）
docker compose -f docker/workflow/docker-compose.yml logs --tail=30 assets-init atlas-init mysql-init s3-init
# 3) 对象确实落到共享实例：库存在于实例账号下，且 application 账号能连上
docker compose -f docker-compose.yml exec mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" opencoze -e "SHOW TABLES LIKE 'workflow_version';"   # dev（仓库根编排）
docker compose -f docker/main/docker-compose.yml exec mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" opencoze -e "SHOW TABLES LIKE 'workflow_version';"   # 生产（自动读 docker/main/.env）
docker compose -f docker-compose.yml exec mysql mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" opencoze -e "SELECT 1;"   # dev（仓库根编排）
docker compose -f docker/main/docker-compose.yml exec mysql mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" opencoze -e "SELECT 1;"   # 生产（自动读 docker/main/.env）
# 4)（可选）共享 rustfs 的数据落点是 bind 挂载 docker/common/data/rustfs，在宿主上看一眼即可。
#    RustFS 与 MinIO 同形态：桶在卷下表现为目录。底层布局只是旁证，判定权威是第 2 条里
#    s3-init 的 ③ ——那一行「opencoze milvus 均可读」是对 S3 API 的实测，不依赖布局。
ls -1 docker/common/data/rustfs
# 5)（可选）资产展开到位：来源 tag 与文件数（期望与镜像内 /app/upstream-assets/docker 一致）
cat docker/workflow/assets/.source && find docker/workflow/assets -type f | wc -l
```

**一次性服务的失败不会静默**：四个服务**任一**非零退出时，`coze-server` 因 `depends_on: service_completed_successfully` 不会启动（`milvus` 只等 `s3-init`），`docker compose ... ps` 里 `coze-server` 会缺位或反复重启。但 `up -d` 的退出码本身不足以下结论（它还可能混着别的服务的问题），所以验收一律以第 1、2 条为准：**看到四个 `Exited (0)` 与各自的完成行才算通过**。

画布产物在镜像里，用 §2.2 的 basename 校验查实际交付的那份（`docker compose ... exec coze-web grep -ro 'basename:"[^"]*"' /usr/share/nginx/html/static/js`，期望 `basename:"/workflow-canvas"`）。再直接请求一次画布入口与一条 `/workflow-canvas/static/js/*.js`：两处都该是 `200`，且 JS 请求回来的必须是 JavaScript 而不是被 SPA 回退成的 HTML。

1. 核对平台 `/health` 的 `commitId`。它仅说明进程存活，不证明上游或画布可用。
2. 用组织 owner / admin 进入 `/agent/workflow`，点击「初始化工作流空间」。代码会确保平台上游账号存在、登录、取个人空间并为组织绑定 App；若上游关闭自助注册，须先创建匹配账号。
3. 每个组织分别初始化。创建最小工作流，打开画布、编辑、保存、刷新，再测试真实调试运行、节点历史、发布与版本查看。
4. 浏览器检查资源与图标没有 404、登录跳转或 CSP 拒绝；观察长会话换票；平台重启后重新打开画布确认可恢复。
5. 测试组织 A 无法读取 B 的工作流、普通成员不能执行组织管理动作；断开上游应显示明确可重试错误，恢复后链路恢复。

受控测试环境注入 `WORKFLOW_V2_E2E_BASE_URL`、测试账号或 cookie，以及组织 B 的对照 workflow / 账号，然后在平台仓库运行：

```bash
bun run scripts/workflow-v2/canvas-e2e-check.ts --json
```

退出码 `0` 才表示三项 API 判据通过；`2` 是缺前置条件。脚本会创建与删除临时工作流，可能自动初始化组织 App（上游没有删除 App 接口）；使用测试组织，不能接受自动建绑时设置 `WORKFLOW_V2_E2E_AUTO_BIND=0`。完整说明见 `scripts/workflow-v2/README.md`。

脚本不替代浏览器静态面、真实节点调试与容器验收。既有 2026-09-30 本机 API 联调记录不能当作当前目标环境已部署成功的证据。

## 7. 运维、排障与回滚

```bash
docker compose -f docker/workflow/docker-compose.yml logs --tail=100 coze-server coze-web

docker compose -f docker/workflow/docker-compose.yml down
```

不要公开原始日志；上游日志可能包含内部错误与业务载荷。`down` 不删除 bind mount 数据；**不要运行 `down -v`，也不要删除 `docker/workflow/data/` 或共享实例里的数据目录来“重置”生产部署**。

上面这条 `down` **不会**停掉共享 MySQL（它属于主服务项目）：本目录的 `down` 之后，共享实例仍在跑，别的消费方不受影响。反过来，停主服务项目（`./docker/deploy.sh down`）会连带停掉本目录依赖的实例，本目录必须先停或同时停。

| 症状 | 排查方向 |
| --- | --- |
| Compose 配置解析失败 | 使用 Docker Compose v2，核对必填变量（`WORKFLOW_STUDIO_TAG` / `WEB_LISTEN_ADDR`，见 §3）与环境文件 |
| `assets-init` 报「当前 tag 的镜像里没有 /app/upstream-assets」 | 该 tag 早于「初始化资产随镜像交付」的发布：换 `WORKFLOW_STUDIO_TAG` 再重跑（§2.1）。临时核对可 `docker run --rm --entrypoint ls <server 镜像> /app/upstream-assets/docker` |
| 初始化服务报「找不到文件或挂载失败」（`create_host_path: false` 报错） | `./assets/` 是否已由 `assets-init` 展开（`cat docker/workflow/assets/.source`；缺失就重跑并看它的日志），以及 `init-mysql.sh` / `init-s3.sh` 是否随本目录交付（§1 交付清单） |
| `manifest unknown` / `unauthorized` | 核对 GHCR 发布任务、确切标签和包权限；必要时用受控 token 经 `docker login --password-stdin` 登录 |
| 画布白屏 / 资源 404（浏览器把 HTML 当 JS 解析） | ① `coze-web` 是否用的是 `-web-canvas` 变体、tag 是否与 server 一致（用 §2.2 的 basename 校验）；② 带前缀的请求有没有被剥离（平台静态反代与 `nginx.conf` 的 `/workflow-canvas/`）；③ 别用根路径版 `-web` 镜像顶替 |
| 平台 502 / 503 | 两侧是否加入共享网络、上游依赖是否健康、容器内 URL 是否正确 |
| `mysql-init` 报「共享 MySQL 不可用（300 秒内未通过认证）」 | 看它给出的两条分支：`服务器可达但 root 认证失败` → 主服务 env 的 `MYSQL_ROOT_PASSWORD` 与实例不一致；`服务器不可达` → `FENIX_FEATURE_MYSQL` 是否为 true、主服务项目是否已起、`MYSQL_HOST_PORT` 是否被占用 |
| `mysql-init` 报「应用账号认证失败」 | 共享实例里该账号已存在但口令不同（`CREATE USER IF NOT EXISTS` 不覆盖已有账号）。按提示改**主服务 env** 的 `MYSQL_PASSWORD`，或在实例里 `ALTER USER` |
| `docker compose -f docker/workflow/docker-compose.yml logs mysql-init` 里只有 `①②③` 没有完成行 | 最后一行就是失败阶段：`②` 之后的报错是权限不足（root 口令不对），`③` 之后是应用账号口令漂移，`④` 之后是 `schema.sql` 执行失败（Atlas 收敛的失败看 `atlas-init` 的日志） |
| `s3-init` 报「共享 rustfs 不可用（300 秒内未通过健康检查）」 | 看它给出的两条分支：`端口可达但健康检查没通过` → 共享实例还没起完（dev `docker compose -f docker-compose.yml ps rustfs`；生产 `docker compose -f docker/main/docker-compose.yml ps rustfs`）；`服务器不可达` → `FENIX_FEATURE_S3` 是否为 true、主服务项目是否已起、本容器是否在 `fenix-server` 网络上 |
| `s3-init` 报「建桶被拒（HTTP 403）」 | 主服务 env 的 `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` 与共享实例启动时用的那份不一致。**独立部署时最容易踩**：漏了主服务 env 那一份 `--env-file`（dev 是仓库根 `.env`、生产是 `docker/main/.env`），compose 就退回编排里的默认凭据，而共享实例用的是主服务 env 里的那份 |
| `s3-init` 报「桶已存在但不属于当前凭据（BucketAlreadyExists）」 | 该桶由同一实例上的**别的**凭据创建。换桶名，或把主服务 env 的 `RUSTFS_*` 改回创建它的那份——脚本不接管别人的桶（接管了 `coze-server` 也会在访问时被拒） |
| `s3-init` 日志末尾有「图标播种有失败项」 | 桶已经建好、栈照常可用，只是画布 / 插件图标可能 404。按日志给出的 `up -d --force-recreate s3-init` 重跑；持续失败查 `docker/workflow/assets/volumes/minio/` 下图标目录是否完整（缺失时先重跑 `assets-init`） |
| `atlas-init` 报连接失败或 HCL 应用错误 | DSN 用的凭据来自主服务 env（`MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`，与 `coze-server` 的 `MYSQL_DSN` 同源）；先按 `mysql-init` 的口径确认共享实例可用，再看它的日志里 Atlas 报的具体差异 |
| `coze-web` 起不来，日志 `host not found in upstream "rustfs"` | nginx 在**启动时**解析上游主机名，共享 rustfs 那时不可达。先起主服务项目再起本目录；共享实例重建（换 IP）后也要 `docker compose ... restart coze-web` 刷新解析 |
| `elasticsearch` 容器反复重启 / `coze-server` 一直不启动 | 宿主 `vm.max_map_count` 是否 ≥ 262144（不足时 ES 卡在 bootstrap check，`docker compose -f docker/workflow/docker-compose.yml logs elasticsearch` 能看到原因）；宿主内存与磁盘是否够 |
| `coze-server` 连到了“另一个 redis” | 见「§9 已知冲突」，不要先改上游配置猜 |
| 初始化失败 / `spaceId` 为 null | 上游登录或注册、个人空间、平台迁移与台账；不要伪造空间 ID |
| code 兑换 / 票据间歇性 401 | 是否跨平台副本、平台是否重启、票据是否过期 |
| 图片不可见 | 签名 URL 的存储域是否可从平台访问、`MINIO_API_HOST` 与 `nginx.conf` 的 `sub_filter` / `Host` 三处是否同为 `rustfs:9000` |
| 删除后上游对象仍在 | 检查 `pending_delete`、对账任务和审计，不直接删除本地归属记录 |

持久化分三处：**共享 MySQL 在 `docker/common/data/mysql`、共享对象存储在 `docker/common/data/rustfs`**（都属主服务项目，见 §8），其余数据（Elasticsearch / Redis / etcd / Milvus）在本目录 `docker/workflow/data/`；初始化资产也在本目录 `docker/workflow/assets/`（由 `assets-init` 从镜像展开，可随时重建）。都在交付面内（bind 挂载），迁移或备份要一起带走。画布产物不在其中：它随镜像交付。上游 Compose 使用固定 `coze-*` 容器名，同一 Docker 主机不能直接再起第二套相同部署做蓝绿发布。

升级顺序为备份 → 固定镜像版本（server 与 `-web-canvas` 同 tag）→ 上游就绪 → 平台迁移与上线 → 全链路验收。备份必须包含平台 PostgreSQL 的归属 / 审计、**共享 MySQL 的定义 / 版本 / 运行数据**、对象存储及配置版本；凭据独立受控保管。

回滚应用不会撤销数据库变更，尤其平台 `0032` 字段重命名与 `atlas-init` 的 Atlas schema apply。先评估两侧旧版本对迁移后库的兼容性，再成组回退平台与上游镜像（server 与 `-web-canvas` 同 tag 一起换）；必要时走已验证的数据库恢复 / 补偿流程，不直接切旧镜像宣称完成。

## 8. 数据搬迁

本目录的数据落点有三次变化，按时间倒序；每次搬迁在通过 §6 验收之前都不要删旧目录。下文用 `<上游源码目录>` 指代旧部署里的上游源码 clone（若沿用旧文档口径即 `/opt/workflow-studio`）——本目录已不再使用 `WORKFLOW_STUDIO_DIR` 变量，也不再需要上游源码。

| 内容 | 位置 |
| --- | --- |
| 栈内数据（**本次变更**：Elasticsearch / Redis / etcd / Milvus） | 旧：`<上游源码目录>/docker/data/bitnami/{elasticsearch,redis,etcd}` 与 `.../docker/data/milvus`；新：`docker/workflow/data/{elasticsearch,redis,etcd,milvus}` |
| MySQL 数据（更早变更，上移到 common） | 旧：`<上游源码目录>/docker/data/mysql`；新：`docker/common/data/mysql` |
| 对象存储数据（更早变更，MinIO → 共享 rustfs） | 旧：`<上游源码目录>/docker/data/minio`（MinIO 自有格式）；新：`docker/common/data/rustfs`（RustFS 自有格式），桶名与对象键不变 |
| 初始化资产与图标播种源（**本次变更**：改由镜像交付） | 旧：`<上游源码目录>/docker/volumes/**`；新：镜像内 `/app/upstream-assets/docker/` → `docker/workflow/assets/**`（由 `assets-init` 展开，可随时重建） |

### 8.1 栈内数据目录（本次变更）

目录名有一处映射：`bitnami/elasticsearch` → `data/elasticsearch`，其余同名（`redis` / `etcd` / `milvus`）。

```bash
# 0) 先备份（后面的 cp 不是备份：拷坏了原目录也坏了）
tar -czf workflow-stackdata-$(date +%Y%m%d).tar.gz -C "<上游源码目录>/docker/data" \
  bitnami/elasticsearch bitnami/redis bitnami/etcd milvus

# 1) 停本栈（避免还有进程在写）
docker compose -f docker/workflow/docker-compose.yml down

# 2) 拷数据（-a 保权限；镜像 tag 未变，同一版本的数据目录可以直接搬）
mkdir -p docker/workflow/data
cp -a "<上游源码目录>/docker/data/bitnami/elasticsearch" docker/workflow/data/elasticsearch
cp -a "<上游源码目录>/docker/data/bitnami/redis"         docker/workflow/data/redis
cp -a "<上游源码目录>/docker/data/bitnami/etcd"          docker/workflow/data/etcd
cp -a "<上游源码目录>/docker/data/milvus"                docker/workflow/data/milvus

# 3) 起本栈，按 §6 验收；旧目录留到验收之后
```

要不要迁按数据价值判断：Redis 只是缓存（可从零起）；etcd 存 Milvus 的元数据、Milvus 存向量数据，两者互相依赖，要么一起迁、要么一起从零起；Elasticsearch 的索引结构由 `setup_es.sh` 在每次启动时按 `es_index_schema` 创建 / 补齐。**生产环境建议四个一起迁**；开发机上没有要保留的业务数据时可以从零起（三个服务各自建空实例）。

**旧目录什么时候可以删：**按上表做完并**通过 §6 验收**、且至少跑过一次真实工作流之后，再删 `<上游源码目录>/docker/data/` 下的 `bitnami/` 与 `milvus`——在那之前回退到旧版编排时仍要读它。`<上游源码目录>/docker/volumes/` 也不再被本目录引用（图标播种源改由镜像交付），要回退旧编排则同样保留。

### 8.2 MySQL：两种口径，任选其一，不要混用

**A. 保留既有数据（生产升级走这条）：**

```bash
# 0) 先备份一次（后面的 cp 不是备份：拷坏了原目录也坏了）
tar -czf workflow-mysql-$(date +%Y%m%d).tar.gz -C "<上游源码目录>/docker/data" mysql

# 1) 停旧栈（本目录与主服务项目都停，避免还有进程在写）
docker compose -f docker/workflow/docker-compose.yml down
./docker/deploy.sh down

# 2) 拷数据（-a 保权限；镜像 tag 未变，同一版本的数据目录可以直接搬）
mkdir -p docker/common/data
cp -a "<上游源码目录>/docker/data/mysql" docker/common/data/mysql

# 3) 打开开关后起共享服务（docker/deploy.env：FENIX_FEATURE_MYSQL）
./docker/deploy.sh validate && ./docker/deploy.sh up

# 4) 按 §6 的验收命令确认库表都在
```

MySQL 的账号口令写在数据目录里：搬过来之后主服务 env 的 `MYSQL_*` **必须保持旧值**。`mysql-init` 会幂等创建库与账号（`CREATE ... IF NOT EXISTS`），已存在的账号它**不会**改口令——口令不一致时它会在第 ③ 步直接报「应用账号认证失败」并停下，而不是让你在 `coze-server` 的报错里猜。

**B. 不迁、从零起（本机开发，或旧库没有要保留的数据）：**

不拷目录，直接按 §4 起共享服务：`mysql-init` 先在共享实例里建库建号、应用 `schema.sql`，再由 `atlas-init` 收敛出全新 schema。旧目录原样留着不动。

**旧目录什么时候可以删：** 按 A 做完并**通过 §6 验收**、且至少完成一次真实工作流发布 / 运行之后，再删 `<上游源码目录>/docker/data/mysql`。在那之前必须保留——回退到上游 `docker/docker-compose.yml` 的直接编排时仍要读它；删之前确认没有别的编排还挂着这个目录。

### 8.3 对象存储：口径 B（不迁、从零起），旧目录先留

**本次收敛采用「不迁」**，理由与代价都写在这里，不是默认省略：

- **技术上不可直搬。** MinIO 与 RustFS 是两套独立实现，各自维护自己的卷内布局与元数据，`cp -a` 数据目录不会让 RustFS 认出 MinIO 的对象——只有走 S3 API 的对象级拷贝才是可靠的。
- **迁移需要一个能同时读写两端的 S3 客户端**（`mc mirror` / `rclone` / `aws s3 sync` 一类）。仓库里没有这样的镜像，而唯一自带 `mc` 的是 MinIO 镜像——引入它就把要收敛掉的制品又带回编排里（`s3-init` 的取舍同理，见 §4）。**为了迁移一次性拉一个镜像，和为了日常建桶长期留一个镜像，是两件不同量级的事**：后者需要一个常驻的编排依赖，前者可以用一次性命令在维护窗口里跑。真要迁移时，用 `mc` / `rclone` 的**宿主态**命令行（不经本编排）按下面的顺序做，跑完即弃。
- **本次要保的量很小且可再生。** `opencoze` 桶里唯一由本栈预置的内容是 `default_icon/` 与 `official_plugin_icon/` 两组静态图标，它们来自镜像内的**版本化文件**（`assets-init` 展开到 `docker/workflow/assets/volumes/minio/`），`s3-init` 第 ④ 步会重新播种——不需要从旧数据里捞。其余是画布过程中产生的图片与文件：本机开发环境没有要保留的；**若生产环境已积累真实用户产物，改用下面的迁移口径，不要当作「可再生」**。

**从零起的操作（默认口径）：**

```bash
# 1) 停本栈（第 1–2 步同 8.2，先停再动开关）
# 2) docker/deploy.env 打开 FENIX_FEATURE_S3，起共享对象存储
./docker/deploy.sh validate && ./docker/deploy.sh up
# 3) 起本栈：s3-init 建 opencoze / milvus 两个桶并播种图标，旧 data/minio 不再被任何服务挂载
```

**别漏了孤儿容器。** 服务从编排里删掉后，Compose 不会替你停掉已存在的容器：升级机器上那个 `coze-minio` 会继续跑着，成为「第二套对象存储」。启动时用 `--remove-orphans`，或事后确认一次：

```bash
docker compose -f docker/workflow/docker-compose.yml up -d --remove-orphans
# 判定：只应剩共享的 rustfs 一个对象存储容器；本栈不再有 coze-minio
docker ps --format '{{.Names}}\t{{.Image}}' | grep -Ei 'minio|rustfs'
```

**需要迁真实产物时（维护窗口，一次性）：**

```bash
# 0) 先在旧 minio 仍可启动的状态下备份，并确认两边凭据
tar -czf workflow-minio-$(date +%Y%m%d).tar.gz -C "<上游源码目录>/docker/data" minio

# 1) 临时起一份旧 minio 指向那份数据（用上游 docker/docker-compose.yml，或任意端口映射），
#    同时确认共享 rustfs 已起（FENIX_FEATURE_S3=true）
# 2) 用宿主态的 mc / rclone 把两个桶整桶镜像到 rustfs（两端都写显式地址与主服务 env 的 RUSTFS_* 凭据）
#    mc mv（不是 mc cp）：搬迁后旧桶不再被引用，避免同一份对象在两个实例里各留一份
# 3) 停掉临时 minio，按 §6 验收桶与图标；确认无误后再决定是否删除旧数据目录
```

**旧目录什么时候可以删：** 按「从零起」做完并**通过 §6 验收**之后即可删 `<上游源码目录>/docker/data/minio`——它已不被任何服务挂载，留着只会让人误以为它还在生效。删之前确认：① 没有别的编排还挂着它（`grep -rn "docker/data/minio" docker/ --include="*.yml"` 应无命中：本目录编排已不引用任何上游目录）；② 若走的是迁移口径，镜像已完成且验收通过。**图标播种源已随镜像交付**（`docker/workflow/assets/volumes/minio/`），只有要回退旧版编排时才需要保留 `<上游源码目录>/docker/volumes/`。

## 9. 已知冲突：`redis` 在两个网络同名

`coze-server` 现在同时接在项目默认网络（本栈的 `redis`）与 `fenix-server`（主服务项目的共享 `redis`，只在 `FENIX_FEATURE_REDIS=true` 时存在）上。Docker 的容器 DNS 对「同一个名字出现在多个已接入网络」没有优先级约定：两个网络各自的记录都会被返回，客户端取哪条取决于返回顺序。两个实例都开着时，本编排注入的 `REDIS_ADDR=redis:6379` 可能连到共享 redis。

判定（两个开关都打开时执行一次，只应看到一条、且是本项目 redis 容器的地址）：

```bash
docker compose -f docker/workflow/docker-compose.yml exec coze-server getent hosts redis
```

处理（按优先级）：

1. **同机不要同时启用**（建议口径）：跑 workflow 的机器把 `FENIX_FEATURE_REDIS` 留成 false。平台的 `RCS_REDIS_URL` 是可选能力，未启用时缓存回退进程内 Map，代价只是 Y.Doc 快照不做持久化。
2. 必须同时启用时：给本目录的 `redis` 服务加唯一别名，并把本目录编排里 `coze-server` 的 `REDIS_ADDR` 改成该别名。这动的是本栈服务定义，属独立变更，先评审再改（本次未做）。

同一类歧义来自「保留名」这条通用规则（`docs/operations/docker-topology.md` §3 规则 7），不限于本栈的 `redis`：任何栈只要在自己的项目网络里留着 `postgres` / `redis` / `rustfs` / `mysql` 之一，而它的容器又同时接在 `fenix-server` 上，就会出现同样的解析歧义。**本仓当前只剩本栈的 `redis` 这一处**：`docker/ragflow/` 原来也有两处，已随共享化消除——栈内 `mysql` 与 `minio` 删除后它改为按名访问共享实例（`mysql:3306` / `rustfs:9000`），栈内 Valkey 改名为 `ragflow-redis`。新增这类服务时先判定它实际连的是哪一个（下面这条命令对「单实例」的情形同样有效，用来确认解析结果只有一个），再按上面两种处理：

```bash
docker compose -f docker/ragflow/docker-compose.yml exec ragflow getent hosts mysql   # 期望：只有共享实例这一个地址
```

本栈其余名字不冲突：`elasticsearch` 只有本栈在用；对象存储这一项**本栈已不再自带**（原来的栈内 `minio` 已删除，`coze-server` / `milvus` / `coze-web` / `s3-init` 都直接指向共享 `rustfs`），所以不存在「两套对象存储谁生效」的歧义——这正是本次收敛的目的。**不要**因为别的栈出现过同名服务就去改本栈配置：判定一律以实测解析结果为准。

## 事实来源

- 上游固定版本的 `backend/Dockerfile`（初始化资产随镜像交付的打包点，目标路径 `/app/upstream-assets`）、`.github/workflows/docker-publish.yml`、`docker/docker-compose.yml`、`frontend/Dockerfile`、`scripts/build_fe.sh`、`frontend/apps/coze-studio/rsbuild.config.ts`。
- 平台 `packages/resources/workflow-v2/fenix.module.ts`、`src/server/services/iframe-ticket.ts`、`src/server/services/upstream-session-store.ts`（后二者均在 workflow-v2 包内）。
- 共享 MySQL 与共享对象存储的定义与宿主前置条件：`docker/common/docker-compose.yml`、`docs/operations/docker-topology.md`（§5、§7）。Elasticsearch 仍是本目录的服务，其宿主前置条件见本文 §1。
- 对象存储收敛的依据：上游 `docker/docker-compose.yml` 的 minio 服务与它的 `mc` 初始化、`backend/infra/storage/impl/minio/minio.go` 的 `createBucketIfNeed`（固定用 `cn-north-1` 建桶——所以本栈把建桶前移到 `s3-init`）、以及 `docker/common/docker-compose.yml` 里 rustfs 的镜像 tag / 凭据键 / 健康检查路径。
- `docs/arch/25-workflow-v2.md`、`docs/design/2026-09-29-workflow-v2-interface-freeze.md`、`docs/operations/upgrade.md`。

本文提供可校验的部署配置；本次核对了 GHCR 的 tags list、manifest（镜像存在、revision 与源码基线一致）与镜像内 `/app/upstream-assets` 的展开内容（144 个文件，与上游 `docker/volumes`、`docker/atlas` 逐文件一致），未启动容器、未做生产联调。本文核对日期 2026-10-14；本次交付标签 `sha-63fd6f8` 对应 `63fd6f8dae1697c7414fe26b41271155adfff788`（上一版基线是 `cd796ef91eae2fd77989eef868874104f6933b37`）。
