/**
 * env 模板的**声明式数据**：键的渲染输入形状、宿主键的手写注记、三份模板的场景差异。
 *
 * 与 `scripts/generate-env-example.ts` 分开是职责边界：这里只放「哪些键、怎么描述」，生成器只负责
 * 「探测声明面、渲染、比对漂移」。数据会长在键的个数上（当前声明面 98 键），逻辑不会，混在一起会让
 * 两边都难以定位。
 *
 * 采集时**两个方向都报错**：新键缺注记、注记对应不到键，都在 `collectHostEntries()` 里当场失败——漏写
 * 与多写的后果都是静默的，把维护动作压成一次明确失败，而不是无声漂移。
 */

/** 模板里一个声明键的渲染输入。 */
export interface EnvEntry {
  readonly key: string;
  /** 声明方：宿主文件名或模块 id，渲染时作为分组标题。 */
  readonly owner: string;
  /** 未设置即启动失败。 */
  readonly required: boolean;
  /** 代码默认值（已渲染成单行文本）；无默认值时 undefined。 */
  readonly defaultValue: string | undefined;
  /** 默认值本身含换行，无法压进单行 `KEY=value`。 */
  readonly multilineDefault: boolean;
  readonly secret: boolean;
  readonly restartRequired: boolean;
  /** 一句话说明：取声明 description 的首句，完整说明留在声明处。 */
  readonly description: string;
  /**
   * 值不写进这份模板：用于「键的真实取值在别处」的条目（如部署模板里由主服务 env 提供的键），
   * 避免把值抄进一份受版本控制的文件。默认值仍会渲染进元信息行，作为未设置时的生效值展示。
   */
  readonly hideValue?: boolean;
}

/** 声明面之外、该场景确有消费方的键；给出消费者，避免它们随模板重写静默消失。 */
export interface UndeclaredKey {
  readonly key: string;
  readonly description: string;
  /** 消费方（文件路径）；写在注释里，供后续把它补进声明面的人定位。 */
  readonly consumer: string;
}

/** 一份模板的场景差异；清单主体由声明面渲染，这里只放差异。`overrides` 是「键 → 场景注记」。 */
export interface EnvTemplate {
  readonly path: string;
  readonly title: string;
  readonly preamble: readonly string[];
  /**
   * 渲染输入的面：`app`（默认）是应用声明面（宿主 + 模块 envDefinitions）；`deploy` 是部署面
   * （deploy.sh 的开关与编排的变量插值），由生成器从 docker/ 与 compose 发现，与声明面无关。
   */
  readonly surface?: "deploy";
  readonly overrides?: Readonly<Record<string, string>>;
  readonly undeclared?: readonly UndeclaredKey[];
}

/**
 * 宿主键的说明与密钥标记。
 *
 * 为什么是一张手写表：`apps/server/src/env.ts` 只导出 `parseEnv` / `Env`，schema 对象没有导出
 * （`assembly-env.test.ts` 同样只能靠探测拿键集合），zod 里也没有「这是不是密钥」这一维。漏写或多写的后果都是
 * 静默的，因此采集时会在两个方向都报错，把维护动作压成一次明确的失败，而不是无声漂移。
 */
export const HOST_ENV_NOTES: Readonly<Record<string, { readonly description: string; readonly secret?: boolean }>> = {
  DATABASE_URL: { description: "PostgreSQL 连接串；缺失即启动失败。", secret: true },
  RCS_API_KEYS: { description: "skill 下载 token 的 HMAC 签名密钥；逗号分隔多把，首个用于签名。", secret: true },
  RCS_SYSTEM_API_KEYS: {
    description: "/api/system/* 管理端点（建用户、建组织、签发用户级 API Key）使用的系统级密钥；逗号分隔。",
    secret: true,
  },
  NODE_ENV: { description: "运行环境标识。" },
  RCS_HOST: { description: "HTTP 监听地址。" },
  RCS_PORT: { description: "HTTP 监听端口。" },
  RCS_CORS_ORIGIN: { description: "允许的跨域来源；`*` 或逗号分隔列表。" },
  RCS_BASE_URL: { description: "服务公开基址；日志、spawn 的 acp-link 与 better-auth 的回退基址。" },
  RCS_VERSION: { description: "版本号；由构建或镜像注入。" },
  RCS_APPLICATION_ROOT: { description: "应用根目录的绝对路径；用于定位 bundle 之外的静态资源。" },
  RCS_ASSEMBLY_PROFILE_PATH: {
    description: "装配 profile 的绝对路径；未设置时用应用根下的 deploy/assembly/ce.json（CE 入口）。",
  },
  APP_BRAND_NAME: { description: "前端品牌名。" },
  APP_LOGO_PATH: { description: "前端 logo 路径；空串表示使用内置品牌资源。" },
  RCS_WS_MAX_PAYLOAD_MB: { description: "单条 WebSocket 消息上限（MB）。" },
  RCS_DISABLE_SCHEDULER: { description: "跳过启动时的 schedulerService.start()；不是全局只读模式。" },
  RCS_FILE_WS_IDLE_TIMEOUT_MS: { description: "file-ws 多久没有心跳即判定为僵尸连接（毫秒）。" },
  RCS_FILE_WS_SWEEP_INTERVAL_MS: { description: "file-ws 僵尸连接巡检间隔（毫秒）。" },
  RCS_FILE_WS_SWEEP_ENABLED: {
    description: "是否启用 file-ws 僵尸巡检；默认关闭，旧机器端未实现 keep_alive 时会被误判，需灰度开启。",
  },
  RCS_FILE_WS_MAX_PAYLOAD_MB: { description: "file-ws 单帧最大载荷（MB）；须容纳远程上传的 base64 帧。" },
  RCS_DISABLE_SIGNUP: { description: "关闭前端自助注册：隐藏注册入口并拒绝新用户注册。" },
  RCS_DEFAULT_MACHINE_ID: { description: "默认远端执行节点 ID（mach_ 前缀）；agent config 未绑定 machineId 时使用。" },
  RCS_DEFAULT_ENGINE_TYPE: { description: "本地执行的默认引擎类型；未设置时按 peri。" },
  RCS_DISABLE_LOCAL_EXECUTION: { description: "禁用 local-default 本地节点；true 后所有实例必须路由到远端 machine。" },
  RCS_REDIS_URL: { description: "Redis 连接串；未设置时缓存回退为进程内 Map。", secret: true },
  RCS_REDIS_PASSWORD: { description: "Redis 密码。", secret: true },
  RCS_REDIS_CLUSTER: { description: "Redis Cluster 取值；设置后优先于单实例模式。" },
  RCS_DB_POOL_MAX: { description: "PostgreSQL 连接池上限。" },
  RCS_DB_IDLE_TIMEOUT_SECONDS: { description: "连接空闲多久被回收（秒）。" },
  RCS_DB_CONNECT_TIMEOUT_SECONDS: { description: "建立连接的超时（秒）。" },
  RCS_DB_MAX_LIFETIME_SECONDS: { description: "连接最长存活时间（秒）。" },
  RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS: { description: "事务内空闲超时（秒）。" },
  RCS_DB_LOCK_TIMEOUT_SECONDS: { description: "锁等待超时（秒）。" },
};

/** 日志族的键由 `packages/logger` 直读、尚未进声明面；两份模板都要保留它们的落点。 */
export const LOGGER_UNDECLARED: readonly UndeclaredKey[] = [
  {
    key: "LOG_LEVEL",
    description: "日志级别（debug / info / warn / error），同时作用于控制台与文件输出。",
    consumer: "packages/logger",
  },
  {
    key: "LOG_FORMAT",
    description: "控制台日志格式（pretty / json）；容器编排通常在 environment 里固定为 json。",
    consumer: "packages/logger",
  },
  { key: "LOG_DIR", description: "滚动日志目录。", consumer: "packages/logger" },
  { key: "LOG_RETENTION_DAYS", description: "日志保留天数；设为 <= 0 关闭清理。", consumer: "packages/logger" },
];

/**
 * 基础服务与共享实例凭据：键落在主服务 env（生产 `docker/main/.env`；dev 是仓库根 `.env`，容器编排与
 * 本地源码开发共用同一份）。消费方不限于基础服务编排本身：消费共享实例的依赖编排（docker/litellm/、
 * docker/ragflow/、docker/workflow/）也读这里的键——这类凭据只定义在主服务 env，放到依赖目录就会与
 * 实例里的账号漂移。
 */
export const BASE_SERVICE_UNDECLARED: readonly UndeclaredKey[] = [
  {
    key: "POSTGRES_PASSWORD",
    description: "基础服务 PostgreSQL 的口令；编排用它拼容器内连接串，改这里也要改已初始化数据库的口令。",
    consumer:
      "docker/common/docker-compose.yml、docker-compose.yml（dev）、docker/main/docker-compose.yml、docker/litellm/docker-compose.yml（litellm-db-init 用它建库与角色）",
  },
  {
    key: "LITELLM_DB_PASSWORD",
    description:
      "共享 postgres 里 litellm 角色的口令；由 docker/litellm/ 的一次性初始化服务建角色时写入，与它的 DATABASE_URL 必须同值（改这里后重跑初始化服务会同步到库内，不必手工改库）。",
    consumer: "docker/litellm/docker-compose.yml（litellm-db-init 建角色、litellm 拼连接串）",
  },
  {
    key: "RUSTFS_ACCESS_KEY",
    description:
      "RustFS 对象存储（S3 兼容）的访问键；未设置时用编排里的本地缺省值。消费方按「共享实例的用户」签约，一把键对应全实例。docker/ragflow/ 不再消费共享实例（改为本栈自带实例、用自己的 RAGFLOW_S3_ACCESS_KEY，见 docker/ragflow/.env.example）。",
    consumer: "docker/common/docker-compose.yml（docker/workflow/ 的 s3-init 用它建桶并播种图标）",
  },
  {
    key: "RUSTFS_SECRET_KEY",
    description: "RustFS 对象存储的密钥；与访问键同属共享实例的一对凭据——拿到就能读写共享实例上的任何桶，消费方同上。",
    consumer: "docker/common/docker-compose.yml（docker/workflow/ 的 s3-init 用它建桶并播种图标）",
  },
  {
    key: "MYSQL_ROOT_PASSWORD",
    description:
      "共享 MySQL 的 root 口令；只在数据目录为空时写入数据库，已有数据时改这里不会改库里的账号（要改口令得同时改库或重建数据目录）。",
    consumer:
      "docker/common/docker-compose.yml（docker/workflow/ 读上游 docker/.env 的同名键、两处必须同值；docker/ragflow/ 的 ragflow-mysql-init 取主服务 env，经部署脚本导出）",
  },
  {
    key: "MYSQL_DATABASE",
    description:
      "共享 MySQL 首次初始化时创建的库名；只在数据目录为空时生效，只有 workflow 的库（opencoze）与它同值——ragflow 的库（rag_flow）由 ragflow-mysql-init 自建。",
    consumer: "docker/common/docker-compose.yml（docker/workflow/ 的 DSN 与它一致）",
  },
  {
    key: "MYSQL_USER",
    description:
      "共享 MySQL 首次初始化时创建的应用账号；只在数据目录为空时生效，只有 workflow 用它——ragflow 用自己的一次性服务建的库级账号（ragflow）。",
    consumer: "docker/common/docker-compose.yml（docker/workflow/ 的 DSN 与它一致）",
  },
  {
    key: "MYSQL_PASSWORD",
    description:
      "共享 MySQL 应用账号的口令；消费方 DSN 里的口令必须与它一致（上游 docker/.env 同名键）。ragflow 用自己的一次性服务建的账号口令（RAGFLOW_MYSQL_PASSWORD）。",
    consumer: "docker/common/docker-compose.yml（docker/workflow/ 的 DSN 与它一致）",
  },
];

/** 部署模板分组标题（同时是渲染顺序）：开关 → common 可选服务 → 部署参数 → 主服务 env 提供的键。 */
export const DEPLOY_OWNER_SWITCHES = "依赖开关（docker/deploy.env）";
export const DEPLOY_OWNER_COMMON = "common 可选服务（随主服务启动）";
export const DEPLOY_OWNER_PARAMS = "部署参数（docker/deploy.env）";
export const DEPLOY_OWNER_MAIN_ENV = "由主服务 env 提供（生产 docker/main/.env、dev 仓库根；本文件不写取值）";

export const DEPLOY_OWNER_ORDER: readonly string[] = [
  DEPLOY_OWNER_SWITCHES,
  DEPLOY_OWNER_COMMON,
  DEPLOY_OWNER_PARAMS,
  DEPLOY_OWNER_MAIN_ENV,
];

/** 部署面一个键的注记：归属决定它写在哪份文件里。 */
export interface DeployKeyNote {
  /** `deploy`：键写进 docker/deploy.env（模板给出注释形式的取值行）；`main-env`：键写进主服务 env。 */
  readonly owner: typeof DEPLOY_OWNER_PARAMS | typeof DEPLOY_OWNER_MAIN_ENV;
  readonly secret?: boolean;
  readonly description: string;
}

/**
 * 部署面键的注记表。键集合由主服务的两份编排（dev / 生产）与 common 的变量插值发现（生成器两个方向都会报错：
 * compose 新增键而表里没有、表里的键已不在编排中），因此这里只回答「这个键写在哪、干什么用」，不维护键集合本身。
 */
export const DEPLOY_KEY_NOTES: Readonly<Record<string, DeployKeyNote>> = {
  FENIX_HTTP_PORT: {
    owner: DEPLOY_OWNER_PARAMS,
    description: "主服务宿主端口（容器内固定 3000）；编排缺省 3001。",
  },
  POSTGRES_PORT: {
    owner: DEPLOY_OWNER_PARAMS,
    description: "PostgreSQL 宿主端口，只绑回环，供本地源码开发与运维工具连接；编排缺省 5432。",
  },
  MYSQL_HOST_PORT: {
    owner: DEPLOY_OWNER_PARAMS,
    description: "共享 MySQL 的宿主端口，只绑回环（mysqldump / 客户端排障用）；编排缺省 3306。",
  },
  POSTGRES_PASSWORD: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    secret: true,
    description:
      "基础服务 PostgreSQL 的口令；与 DATABASE_URL 中的口令必须一致；docker/litellm/ 的初始化服务也用它建库与角色。",
  },
  MYSQL_ROOT_PASSWORD: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    secret: true,
    description:
      "共享 MySQL 的 root 口令；消费方 docker/workflow/ 读的是上游 docker/.env 里的同名键（两处必须同值）、docker/ragflow/ 的初始化服务取主服务 env（经部署脚本导出），不一致时初始化会以「认证失败」停下。",
  },
  MYSQL_DATABASE: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    description:
      "共享 MySQL 首次初始化时创建的库名（只在实例数据目录为空时生效）；必须与 workflow DSN 里的库名一致（当前用 opencoze）。",
  },
  MYSQL_USER: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    description:
      "共享 MySQL 首次初始化时创建的应用账号（只在实例数据目录为空时生效）；必须与 workflow DSN 里的账号一致。",
  },
  MYSQL_PASSWORD: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    secret: true,
    description:
      "共享 MySQL 应用账号的口令；必须与 workflow DSN 里的口令一致（上游 docker/.env 同名键）；ragflow 有自己的库级账号，口令见 docker/ragflow/.env。",
  },
  RUSTFS_ACCESS_KEY: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    description:
      "RustFS 对象存储的访问键；编排缺省 fenix；只有 docker/workflow/ 的初始化服务用它建桶。docker/ragflow/ 自带实例、用本目录 .env 的 RAGFLOW_S3_ACCESS_KEY。",
  },
  RUSTFS_SECRET_KEY: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    secret: true,
    description:
      "RustFS 对象存储的密钥；与访问键同属共享实例的一对凭据（各消费方都能读写实例上的任何桶，因此当前只有 docker/workflow/ 在用）。",
  },
  RCS_API_KEYS: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    secret: true,
    description: "应用必填；编排对该键没有兜底值，缺失即启动失败。",
  },
  REGISTRY_SECRET: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    secret: true,
    description: "与 sandbox / 控制台共享的注册密钥；编排缺省只服务本地，生产必须显式替换。",
  },
  RCS_SECRET_ENCRYPTION_KEY: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    secret: true,
    description: "敏感配置的解密密钥；编排缺省为空串。",
  },
  APP_BRAND_NAME: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    description: "前端品牌名；编排缺省 Fenix。",
  },
  APP_LOGO_PATH: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    description: "前端 logo 路径；编排缺省为空串（使用内置品牌资源）。",
  },
  RCS_DISABLE_SCHEDULER: {
    owner: DEPLOY_OWNER_MAIN_ENV,
    description: "跳过启动时的 schedulerService.start()；编排缺省 false。",
  },
};

/**
 * common 的可选服务开关。这是 docker/deploy.sh 里 `COMMON_OPTIONAL_FEATURES` 的镜像——后者是开关名到
 * `--profile` 的实际接线处，改一处必须改两处；`scripts/__tests__/env-example-generator.test.ts` 逐项比对两边。
 */
export const COMMON_FEATURE_SWITCHES: readonly { readonly name: string; readonly description: string }[] = [
  {
    name: "REDIS",
    description: "Redis 缓存与 Y.Doc 快照持久化（消费方只有主服务 rcs）；未启用时缓存回退进程内 Map。",
  },
  {
    name: "S3",
    description:
      "RustFS 对象存储（S3 兼容）；消费方只有 docker/workflow/（桶 opencoze、milvus，由它的一次性初始化服务建）。docker/ragflow/ 不消费它——对象存储是 docker/ragflow/ 自带的特例，与这个开关无关。",
  },
  {
    name: "MYSQL",
    description:
      "共享 MySQL（消费方：docker/workflow/ 的库 opencoze 与 docker/ragflow/ 的库 rag_flow）；业务 schema 由消费方自己的初始化服务应用，不由本服务承担。",
  },
];

/** 三份产出的场景差异；覆盖键是否正确由 {@link assertTemplateOverrides} 兜住，拼错键名不会静默失效。 */

/**
 * 声明面之外、两份应用面模板共用的键：日志族、基础服务凭据，以及只被 acp-runtime-cli 读取的两个键。
 * 两份模板（本地开发 `.env.example` 与主服务生产 `docker/main/.env.example`）的 undeclared 必须一致，
 * 共用一个常量避免逐份抄写后漂移。声明面补上这些键时，{@link assertTemplateOverrides} 会当场报错。
 */
const APP_UNDECLARED: readonly UndeclaredKey[] = [
  ...LOGGER_UNDECLARED,
  ...BASE_SERVICE_UNDECLARED,
  {
    key: "RCS_URL",
    description:
      "Agent 侧回连主服务的 WebSocket 基址；daemon 按它改写 skill 下载链接（宿主生成的地址在容器内不可达）。",
    consumer: "packages/acp-runtime-cli（读入后经 ServerConfig 交给 packages/plugin-*/*-handler.ts）",
  },
  { key: "RCS_TENANT_ID", description: "远端运行时注册时携带的租户标识。", consumer: "packages/acp-runtime-cli" },
];

export const ENV_TEMPLATES: readonly EnvTemplate[] = [
  {
    path: ".env.example",
    title: "FenixAgent 本地开发环境变量（生成物）",
    preamble: [
      "以本文件为起点创建本地配置：`cp .env.example .env`；Bun 启动时自动读取仓库根的 .env。",
      "本文件由 `bun run scripts/generate-env-example.ts` 生成，勿手改（`precheck` 的 env-example 步骤按字节比对）。",
      "",
      "覆盖面 = 宿主 apps/server/src/env.ts 的自有键 + 全部模块 fenix.module.ts 的 envDefinitions，不按 assembly",
      "profile 过滤：部署要能配全，缺一个键就等于该旋钮只能靠代码默认值；键与逐键说明的真相来源就是这些声明处。",
      "",
      "键行一律是注释行：按需取消注释并填写，其余键走代码默认值。元信息含义：必填=未设置即启动失败；默认=未设置",
      "时生效的代码默认值；改值需重启=该值在装配期被固化。密钥类键不写任何取值——本地开发用 `openssl rand -hex 16`",
      "一类方式自行生成。",
    ],
    overrides: {
      DATABASE_URL:
        "本地开发可用 `docker compose up -d postgres` 起的实例（库/用户/口令见仓库根 docker-compose.yml）；本模板不写连接串样例。",
      RCS_API_KEYS: "本地开发任意非空串即可启动；生产必须是长随机值，且不得提交。",
      RCS_BASE_URL: "本地开发通常填 http://localhost:3000。",
    },
    undeclared: APP_UNDECLARED,
  },
  {
    path: "docker/main/.env.example",
    title: "FenixAgent 主服务部署环境变量（生成物）",
    preamble: [
      "用法：`./docker/deploy.sh init` 把它落成同目录的 .env（已存在则不覆盖），或在本目录 `cp .env.example .env`。",
      "本文件与 docker/main/docker-compose.yml 同目录（落成后即 `docker/main/.env`）：compose 的项目目录就是这里，",
      "变量插值与 `env_file` 都读同目录的 `.env`（目标机上不必指定 `--env-file`，也不依赖仓库根 .env）。",
      "本文件由 `bun run scripts/generate-env-example.ts` 生成，勿手改（`precheck` 的 env-example 步骤按字节比对）。",
      "",
      "覆盖面 = 宿主 apps/server/src/env.ts 的自有键 + 全部模块 fenix.module.ts 的 envDefinitions；键与逐键说明的",
      "真相来源就是那些声明处。键行一律是注释行：按需取消注释并填写，其余键走代码默认值。元信息含义：必填=未设置",
      "即启动失败；默认=未设置时生效的代码默认值；改值需重启=该值在装配期被固化。密钥类键不写任何取值——生产用",
      "`openssl rand -hex 32` 一类方式自行生成，且不得提交。",
    ],
    overrides: {
      DATABASE_URL:
        "容器部署时由编排的 `environment` 显式给出（`postgres://rcs:…@postgres:5432/rcs`，优先级高于本文件），本键只在绕过容器直跑源码时才需要。",
      RCS_API_KEYS: "生产必须是长随机值（`openssl rand -hex 32`）；缺失或为空即启动失败，且不得提交。",
      RCS_BASE_URL: "填部署方可达的对外地址（如 https://agent.example.com）：影响生成的回链与 skill 下载链接。",
      WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL:
        "docker 部署由 `./docker/deploy.sh` 在 init / up / deploy 时按主机名生成并固化（写入本文件、之后不再改动）；" +
        "独立部署须自行填部署方可控的邮箱，并登记为保留账号（见 docker/workflow/README.md §5）。",
    },
    undeclared: APP_UNDECLARED,
  },
  {
    path: "docker/deploy.env.example",
    title: "FenixAgent 部署配置模板（生成物）",
    surface: "deploy",
    preamble: [
      "用法：`./docker/deploy.sh init` 把它复制成 docker/deploy.env（已存在则不覆盖）；deploy.env 不进版本控制。",
      "本文件由 `bun run scripts/generate-env-example.ts` 生成，勿手改（`precheck` 的 env-example 步骤按字节比对）。",
      "",
      "覆盖范围 = docker/deploy.sh 的配置面：依赖开关（按 docker/ 下带 docker-compose.yml 的目录发现，与脚本的",
      "目录发现同源）、common 的可选服务开关、部署参数（主服务与 common 编排里变量插值形式的键），以及这些编排会",
      "从主服务 env 读取的键——最后一段只列键与去处：取值请写进主服务 env（生产 docker/main/.env、dev 仓库根 .env），",
      "本文件进版本控制，密钥不得落在里面。",
      "",
      "键行一律是注释行：不写就等于用脚本与 compose 的缺省行为（未列出的依赖不启动），要改再取消注释。",
      "镜像版本不在这里：所有镜像固定版本、写在各自 compose 文件里（主服务 rcs 的 image 行随发布更新，dev 与生产两份编排同步）。",
      "权威文档：docs/operations/docker-topology.md（§7 配置、§8 env 规范）。",
    ],
  },
];
