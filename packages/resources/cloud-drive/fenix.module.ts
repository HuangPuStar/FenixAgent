import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";

/**
 * CloudDrive 资源模块描述符。
 *
 * 本模块是「个人云盘」的唯一 owner：文件、目录、版本、回收站、上传与配额全部由外部 CloudDrive
 * 持有，Fenix 不建表、不做状态缓存，只做受信任的服务端代理。服务端交付物是 `/web/cloud-drive/*`
 * 的 16 条路由（`src/server/routes/web/`）与一个出站 HTTP client（`src/server/client/`）；
 * 装配面上的唯一消费者是宿主 `apps/server`。
 *
 * `dependsOn: []`：`src/**` 只有 `@fenix/platform-sdk` 的类型/工具导入，本包不引用其它资源模块的
 * 表、服务或配置；它是资源装配图里的叶子，方向由消费者声明，本包不写反向边。
 *
 * 不声明 `create`：本模块没有进程级单例（没有 DB 句柄、连接池或后台任务），路由工厂与 client 都是
 * 无状态函数/按请求构造，硬造一个 `createXxxModule()` 只会多一条与 `./server` 重复的公开面。
 *
 * 声明 `web`：浏览器入口是**说明符字符串**（WebShell 生成器只做 AST 静态读取、不执行 manifest），
 * 取值必须是字面量并指向本包 `exports["./web/contribution"]`。载荷（页面、导航图标、i18n）只存在于
 * 该入口导出的值里，不会沿 registry 进入服务端装配图——server 侧拿到的只有这一条字符串。
 *
 * `envDefinitions` 的归属判据：四个键只被本包消费，宿主 `apps/server/src/env.ts` 不得重复声明
 * （`assertNoHostKeyOverride` 会在启动期拒绝同名）。两个地址/密钥键是**可选**的，与 Agent Sites
 * 的先例一致：CloudDrive 是可选外部依赖，未配置时服务必须能启动，请求按 `CLOUD_DRIVE_NOT_CONFIGURED`
 * 返回 503，而不是让整个进程起不来。空串按未配置处理（compose 的 `${VAR:-}` 在未设置时透传空串）。
 */
export const moduleManifest = {
  id: "cloud-drive",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.cloud-drive"],
  web: {
    id: "cloud-drive",
    contribution: "@fenix/resource-cloud-drive/web/contribution",
  },
  contributions: [
    {
      id: "cloud-drive.web",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createCloudDriveWebRoutes(host)),
    },
  ],
  envDefinitions: [
    {
      moduleId: "cloud-drive",
      key: "CLOUDDRIVE_BASE_URL",
      schema: z.preprocess(
        (value) => (value === "" ? undefined : value),
        z
          .string()
          .url()
          .regex(/^https?:\/\//, "只支持 http/https")
          .optional(),
      ),
      secret: false,
      restartRequired: true,
      description:
        "CloudDrive REST 基址（如 http://127.0.0.1:8080），只允许 http/https；未配置或空串表示未启用个人云盘，/web/cloud-drive/* 返回 503。宿主投影为模块配置 baseUrl。",
    },
    {
      moduleId: "cloud-drive",
      key: "CLOUDDRIVE_MASTER_KEY",
      schema: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
      secret: true,
      restartRequired: true,
      description:
        "CloudDrive master key，只在服务端使用：禁止下发浏览器，禁止写入日志、错误文案与响应。与 CLOUDDRIVE_BASE_URL 同时配置才启用个人云盘；宿主投影为模块配置 masterKey。",
    },
    {
      moduleId: "cloud-drive",
      key: "CLOUDDRIVE_KEY_ID",
      schema: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
      secret: false,
      restartRequired: true,
      description:
        "可选的 CloudDrive key id（多 key 轮换时指定，随请求发送 X-Key-Id）。未配置时由 CloudDrive 使用其默认 key id。",
    },
    {
      moduleId: "cloud-drive",
      key: "CLOUDDRIVE_TIMEOUT_MS",
      schema: z.coerce.number().int().positive().default(120000),
      defaultValue: 120000,
      secret: false,
      restartRequired: true,
      description:
        "CloudDrive 出站请求超时（毫秒），默认 120000；冷启动首次写操作实测可达约 65s，finalize 含异步提交，30s 会把正常写入误判为超时。下载只在等待响应头阶段计时，避免把长传输误判为超时。",
    },
  ],
} satisfies ModuleManifest;
