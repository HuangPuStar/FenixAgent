import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";

/**
 * `REGISTRY_SECRET` 的默认值：与宿主 `apps/server/src/env.ts` 原行**同字面量**（占位性质的固定共享密钥）。
 * 本批只搬声明位置、不改取值：该默认值是「未配置即退化为固定共享密钥」的既有部署行为，删除它属行为变化
 * （会让未配置该变量的部署在启动期失败），不在 1.7 C 块范围内，需另行裁定。按密钥红线，此处不复述取值。
 */
const REGISTRY_SECRET_DEFAULT = "rcs-registry-secret";

/**
 * Agent Runtime 的静态装配描述符。
 *
 * `dependsOn` 为空：Runtime 只允许依赖 platform-sdk、四个基础运行包以及 Machine/Sandbox 的
 * 专用公开运行入口，不依赖 AccessControl、Identity 或任何资源模块。Runtime 接受的是已经
 * 授权的通用启动输入，不解释 actor/role/visibility。
 *
 * 工厂按需加载运行组合根（`src/runtime.ts`），使生成的 registry 保持为轻量 manifest 索引，
 * 不把 Elysia、Drizzle 与 relay 全量拖进任何导入 registry 的位置。
 *
 * `create` 返回收敛后的运行 port（`AgentRuntimeModule.runtime`），不是服务端公开入口的整体
 * 表面（1.4 W3 前的临时形态）：端口的目标是让 registry 驱动的装配能拿到唯一的实例/环境
 * 生命周期入口，而宿主装配面（`./server` 的注入 port、路由工厂）由宿主显式调用。
 *
 * 声明 `contributions`（1.5e）：`/web/control`、`/web/environments`、`/web/instances` 的路由实例由本模块
 * 以惰性构造函数 `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web"` 指明挂宿主
 * `/web` 聚合面——路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。**基础模块
 * 同样参与贡献挂载**：装配的 mount 阶段遍历全部解析出的模块（`orderContributions`），不区分类别。惰性
 * import 与 `create` 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 1.5f 追加两条 `api` 槽贡献：实例接入（`/api/agents/:agentId/instances/connect`）与 OpenAI 兼容对话
 * （`/api/agents/:agentId/v1/chat/completions`）。两者与 `/web` 面共用同一份会话守卫，实例接入另需宿主
 * 请求错误日志（读 `request` 上的 requestId，包内没有来源）。
 *
 * 1.5f-1b 追加一条顶层 `app` 槽贡献：`/acp/*`。它与 `/web`、`/api` 都不同前缀，且是唯一同时需要会话
 * 守卫与 `authenticateRequest` 本身的路由面——WS 升级在 `open` 里自行认证并区分「未认证 / 无组织上下文 /
 * 通过」（分别以 4003 关闭），不能改用 `sessionAuth` 宏。
 *
 * 声明 `envDefinitions`（1.7 C 块，批 C-agent-runtime）：本模块的部署级旋钮原先只在宿主
 * `apps/server/src/env.ts` 声明，再经 `buildModuleConfigs()` 手工投影成模块配置。本批按用户裁定「只迁有
 * 唯一模块 owner 的键」，把宿主同名行**逐字等价**搬到这里，由 `loadServerEnv` 在启动期统一校验并汇总
 * （路线 A：`envDefinitions` 只承担「启动期校验 + 汇总」，值仍走宿主手工投影，模块继续经
 * `getAgentRuntimeConfig()` 读取——不改造模块 config 形态，也不引入通用拆分器）。**加声明与删宿主同名行
 * 必须成对落地**：两侧同名会被 `assertNoHostKeyOverride()` 在启动期直接拒绝（同一变量只能有一个声明处），
 * 本任务只负责声明这一半，宿主侧删除与派生下沉由主控在整合阶段同批完成。
 *
 * 十键按归属分三类，判据是「是否有唯一模块 owner」：
 * 1. **运行态旋钮**——三项并发上限、ACP 空闲 / 巡检 / 业务超时、`/acp/ws` 保活间隔、chat-channel 连接上限。
 *    消费方只有本模块的实例生命周期、`acp-ws-handler` 与 chat-channel 装配（`chat-channel-bootstrap`）。
 * 2. **环境解析与协议入口的部署值**——`REGISTRY_SECRET`（`/acp/*` 接入方共享密钥，唯一消费者是 `/acp/*`
 *    协议入口）与 `WORKSPACE_ROOT`（workspace 根目录）。`WORKSPACE_ROOT` 同时是 review §8.1 第 9 条登记的
 *    server 装配面内唯一真违规点（`services/workspace-resolver.ts` 直读 `process.env`），本批**只声明**：
 *    resolver 改读模块配置、宿主 `config.ts` 的派生下沉，由主控在整合阶段处理。为此它的形状保持与宿主
 *    原行等价（`optional()`，**不**收紧为 `min(1)`——空串行为变化需单独裁定）。
 * 3. **补齐声明**——`YJS_MAX_CLIENTS`：宿主 schema 从未声明此键，唯一读取点是 `chat-channel-bootstrap.ts`
 *    的 `parseInt(process.env.YJS_MAX_CLIENTS || "", 10) || 200` 直读。声明它带来一处已知行为差异：现状下
 *    非法值静默回落到 200、负值被原样接受，声明后非法值将在启动期校验失败。该差异已登记在 review
 *    `task-1.7-db-config-migration.md` §8.1 第 15 条（owner C 块），与「改为经 options 注入」同批收口。
 *    值仍在装配期被读一次并固化，`restartRequired: true` 与其余键口径一致。
 *
 * 默认值语义逐键照抄宿主原文，不做「顺手改进」：`optional()` 无默认值的键（并发总量上限、定时并发上限、
 * `WORKSPACE_ROOT`）**省略** `defaultValue`——`loadDeclaredEnv` 在 `defaultValue === undefined` 时走
 * `schema.parse(rawValue)`，写 `null` 会让 `parse(null)` 的行为漂移；其余键写与 schema `.default()` 同值的
 * `defaultValue`。`secret` 只对 `REGISTRY_SECRET` 为 `true`（密钥材料，禁止进日志 / 响应 / 错误文案）；
 * `restartRequired` 全为 `true`：这些值在装配期一次性投影进模块配置，改后必须重启才生效。
 *
 * **不迁的兄弟键**（多个模块 / 宿主装配面共享，保留宿主 schema）：`RCS_DEFAULT_MACHINE_ID`（本模块兜底机器、
 * machine 模块与宿主 core-bootstrap 三方消费）、`RCS_DEFAULT_ENGINE_TYPE` / `RCS_DISABLE_LOCAL_EXECUTION`
 * （同为 Agent 路由类宿主派生：前者由本包 `src/server/config.ts` 与调用方消费，后者同时被本包
 * `environment-orchestration.ts` 与 machine 的 `local-node-service.ts` 读取，没有唯一 owner）、
 * `RCS_FILE_WS_MAX_PAYLOAD_MB`（宿主 `main.ts` 的 uWS 全局上限 + 本包 file-ws 路由 + machine 常量）、
 * `RCS_BASE_URL` / `RCS_PORT`（宿主多模块共享）。
 */
export const moduleManifest = {
  id: "agent-runtime",
  kind: "agent-runtime",
  dependsOn: [],
  capabilities: ["runtime.agent"],
  envDefinitions: [
    // ── 运行态旋钮：并发上限 ──
    {
      moduleId: "agent-runtime",
      key: "RCS_AGENT_MAX_CONCURRENCY",
      schema: z.coerce.number().int().positive().optional(),
      secret: false,
      restartRequired: true,
      description:
        "全部活跃 Agent 实例的并发总量上限；未配置即不限制总量。由实例准入判定读取（模块配置 agentMaxConcurrency）。",
    },
    {
      moduleId: "agent-runtime",
      key: "RCS_USER_AGENT_MAX_CONCURRENCY",
      schema: z.coerce.number().int().positive().default(10),
      defaultValue: 10,
      secret: false,
      restartRequired: true,
      description: "单用户活跃 Agent 实例的并发上限；默认 10。与总量上限同一处准入判定。",
    },
    {
      moduleId: "agent-runtime",
      key: "RCS_SCHEDULED_AGENT_MAX_CONCURRENCY",
      schema: z.coerce.number().int().positive().optional(),
      secret: false,
      restartRequired: true,
      description: "定时任务触发的活跃 Agent 实例并发上限；未配置即不限制定时来源。",
    },
    // ── 运行态旋钮：ACP 实例生命周期 ──
    {
      moduleId: "agent-runtime",
      key: "RCS_ACP_IDLE_TIMEOUT_SECONDS",
      schema: z.coerce.number().int().positive().default(300),
      defaultValue: 300,
      secret: false,
      restartRequired: true,
      description: "非交互式 ACP 实例的空闲回收阈值（秒）；默认 300。空闲巡检超过该时长后自动停止实例。",
    },
    {
      moduleId: "agent-runtime",
      key: "RCS_ACP_IDLE_SWEEP_INTERVAL_SECONDS",
      schema: z.coerce.number().int().positive().default(300),
      defaultValue: 300,
      secret: false,
      restartRequired: true,
      description: "非交互式 ACP 实例的空闲巡检间隔（秒）；默认 300。",
    },
    {
      moduleId: "agent-runtime",
      key: "RCS_ACP_ACTIVITY_TIMEOUT_SECONDS",
      schema: z.coerce.number().int().positive().default(1200),
      defaultValue: 1200,
      secret: false,
      restartRequired: true,
      description: "非交互式实例无 ACP 业务活动的硬超时（秒）；默认 1200。",
    },
    // ── 运行态旋钮：传输层 ──
    {
      moduleId: "agent-runtime",
      key: "RCS_WS_KEEPALIVE_INTERVAL",
      schema: z.coerce.number().int().positive().default(20),
      defaultValue: 20,
      secret: false,
      restartRequired: true,
      description:
        "`/acp/ws` 服务端 keep_alive 数据帧间隔（秒）；默认 20。须显著小于 Bun 层 idle timeout，否则应用层保活来不及判死连接。",
    },
    {
      moduleId: "agent-runtime",
      key: "YJS_MAX_CLIENTS",
      schema: z.coerce.number().int().positive().default(200),
      defaultValue: 200,
      secret: false,
      restartRequired: true,
      description:
        "chat-channel YJS WebSocket 的最大并发连接数；默认 200。宿主 schema 原本未声明此键（唯一读取点是 chat-channel-bootstrap 的直读），本批补齐：非法值由「静默回落默认」变为启动期校验失败、负值不再被接受。",
    },
    // ── 环境解析与协议入口的部署值 ──
    {
      moduleId: "agent-runtime",
      key: "REGISTRY_SECRET",
      schema: z.string().default(REGISTRY_SECRET_DEFAULT),
      defaultValue: REGISTRY_SECRET_DEFAULT,
      secret: true,
      restartRequired: true,
      description:
        "`/acp/*` 接入方必须携带的共享密钥（query secret）。密钥材料，禁止进日志 / 响应 / 错误文案。默认值沿用宿主原行的固定字面量（占位密钥），删除它属行为变化，本批只迁移不裁定。",
    },
    {
      moduleId: "agent-runtime",
      key: "WORKSPACE_ROOT",
      schema: z.string().optional(),
      secret: false,
      restartRequired: true,
      description:
        "workspace 根目录；未配置时回落到宿主按运行目录解析的 workspaces（工作区路径公式的根）。本批只声明，形状与宿主原行等价（optional，未收紧为 min(1)）。",
    },
  ],
  contributions: [
    {
      id: "agent-runtime.web-control",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentRuntimeWebControlRoutes(host)),
    },
    {
      id: "agent-runtime.web-environments",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentRuntimeWebEnvironmentsRoutes(host)),
    },
    {
      id: "agent-runtime.web-instances",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentRuntimeWebInstancesRoutes(host)),
    },
    {
      id: "agent-runtime.api-instances",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentRuntimeApiInstanceRoutes(host)),
    },
    {
      id: "agent-runtime.api-openai-chat",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentRuntimeOpenaiChatRoutes(host)),
    },
    {
      id: "agent-runtime.app-acp",
      kind: "app-route",
      slot: "app",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentRuntimeAcpAppRoutes(host)),
    },
  ],
  create: () => import("./src/runtime").then((module) => module.createAgentRuntimeModule()),
} satisfies ModuleManifest;
