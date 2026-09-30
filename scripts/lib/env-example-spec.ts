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

/** 三份产出的场景差异；覆盖键是否正确由 {@link assertTemplateOverrides} 兜住，拼错键名不会静默失效。 */
/** 主模板路径：另两份模板由它加场景差异派生，因此它自己不需要 `overrides`。 */
export const MAIN_TEMPLATE_PATH = "deploy/env/rcs.example";

export const ENV_TEMPLATES: readonly EnvTemplate[] = [
  {
    path: MAIN_TEMPLATE_PATH,
    title: "FenixAgent 部署环境变量模板（真相来源）",
    preamble: [
      "本文件由 `bun run scripts/generate-env-example.ts` 机械产出，勿手改；`bun run precheck` 的 env-example",
      "步骤按字节比对，内容漂移即失败。",
      "",
      "覆盖面 = 宿主 apps/server/src/env.ts 的自有键 + 全部模块 fenix.module.ts 的 envDefinitions，不按 assembly",
      "profile 过滤：部署要能配全，缺一个键就等于该旋钮只能靠代码默认值。",
      "",
      "键行一律是注释行：取消注释后才生效，未填写的键走代码默认值。密钥类键不写任何取值（连样例也不写），真实值",
      "来自部署平台的 secret store、K8s/Docker secret 或受控文件。",
      "",
      "元信息含义：必填=未设置即启动失败；默认=未设置时生效的代码默认值；改值需重启=该值在装配期被固化。",
      "同一次渲染另产出仓库根 .env.example（本地开发起点）与 docker/prod/.env.example（生产编排），二者在这份清单",
      "之上只追加各自场景的注记与少量场景键。",
    ],
  },
  {
    path: ".env.example",
    title: "FenixAgent 本地开发环境变量（生成物）",
    preamble: [
      "以本文件为起点创建本地配置：`cp .env.example .env`；Bun 启动时自动读取仓库根的 .env。",
      "本文件由 `bun run scripts/generate-env-example.ts` 生成，勿手改（门禁同 deploy/env/rcs.example）。",
      "",
      "键行一律是注释行：按需取消注释并填写，其余键走代码默认值。密钥类键不写任何取值——本地开发也用",
      "`openssl rand -hex 16` 一类方式自行生成。完整清单与逐键说明的真相来源是 deploy/env/rcs.example。",
    ],
    overrides: {
      DATABASE_URL:
        "本地开发可用 `docker compose up -d postgres` 起的实例（库/用户/口令见仓库根 docker-compose.yml）；本模板不写连接串样例。",
      RCS_API_KEYS: "本地开发任意非空串即可启动；生产必须是长随机值，且不得提交。",
      RCS_BASE_URL: "本地开发通常填 http://localhost:3000。",
    },
    undeclared: [
      ...LOGGER_UNDECLARED,
      {
        key: "RCS_URL",
        description:
          "Agent 侧回连主服务的 WebSocket 基址；daemon 按它改写 skill 下载链接（宿主生成的地址在容器内不可达）。",
        consumer: "packages/acp-runtime-cli（读入后经 ServerConfig 交给 packages/plugin-*/*-handler.ts）",
      },
      { key: "RCS_TENANT_ID", description: "远端运行时注册时携带的租户标识。", consumer: "packages/acp-runtime-cli" },
    ],
  },
  {
    path: "docker/prod/.env.example",
    title: "FenixAgent 生产编排环境变量（生成物）",
    preamble: [
      "以本文件为起点创建编排配置：`cp docker/prod/.env.example docker/prod/.env`，再执行",
      "`docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml up -d`。",
      "本文件由 `bun run scripts/generate-env-example.ts` 生成，勿手改（门禁同 deploy/env/rcs.example）。",
      "",
      "键行一律是注释行：按需取消注释并填写，其余键走代码默认值。密钥类键不写任何取值，真实值来自部署平台的 secret",
      "store 或受控文件。完整清单与逐键说明的真相来源是 deploy/env/rcs.example。",
      "",
      "编排对下列键使用了不带默认值的变量插值：缺值时 compose 会以空串代入并告警，对应能力随之不可用：",
      "OPENAI_API_KEY（Agent 智能生成）、REGISTRY_SECRET（注册共享密钥）、AGENT_SITES_MASTER_KEY（站点托管）。",
    ],
    overrides: {
      DATABASE_URL:
        "本编排已在 environment 中固定为容器网络内的 postgres，.env 里的取值对 rcs 服务无效（environment 优先于 env_file）。",
      RCS_API_KEYS: "应用自身必填；编排对该键做了空值兜底插值，留空会让服务启动失败。",
      RCS_BASE_URL: "公网访问地址；compose 缺省回落 http://localhost:3000。",
      RAGFLOW_API_URL: "RagFlow 是独立编排，必须填 rcs 容器可路由的地址，不要写 localhost。",
      REGISTRY_SECRET: "代码内置的是与旧版一致的占位默认值，生产必须显式替换为随机密钥。",
      HINDSIGHT_MCP_URL:
        "Hindsight 是独立编排，必须填 rcs 容器可路由的地址，不要写 localhost；不设置即不启用记忆能力。",
    },
    undeclared: LOGGER_UNDECLARED,
  },
];
