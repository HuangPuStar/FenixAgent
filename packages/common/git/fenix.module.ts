import type { ModuleManifest } from "@fenix/platform-sdk";
import { z } from "zod/v4";

/**
 * 公共 Git 模块（`@fenix/git`）描述符。
 *
 * 职责：Forgejo 之上的公共托管平台接入层——仓库绑定、Issue／评论／标签读写、附件与 Webhook 事件的
 * 统一入口。仓库、Issue、评论、标签与附件的事实源是 Forgejo；本包只保存 AOS 侧的绑定与事件账本
 * （四张表，见 `db/schema.ts`）。工单模块（`@fenix/resource-tickets`）是本包的消费者之一，通过
 * `GitService.createScopedClient` 取得受控作用域，本包不依赖工单，也不理解通知与工单语义。
 *
 * `kind: "resource"`：本包用现有可选能力槽注册（`deploy/assembly/ce.json` 默认不含 `git`），不需要
 * 新的 manifest 类别或第二套注册机制。`dependsOn: []`：本包服务端生产代码只依赖平台契约
 * （`@fenix/platform-sdk/server` 的 `getDatabase()`）与自身表，不导入其他资源模块。
 *
 * `envDefinitions`（键的唯一声明处，宿主 `env.ts` 不得重复）：
 * - `AOS_GIT_CONFIG_FILE`：连接配置 JSON 的路径，空串表示未配置；启用本模块时启动失败（见
 *   `src/module.ts`）。配置只允许运维固定，用户请求不能覆盖 URL。
 * - `AOS_GIT_PROVISION_TOKEN` / `AOS_GIT_SERVICE_TOKEN`：初始化凭据与日常写入凭据，刻意分开——
 *   初始化（建仓库、建 Webhook）只在 bootstrap 执行，日常写入用受限服务账号。两者都是密钥材料，
 *   禁止进日志、响应与错误文案。
 * - `AOS_GIT_FORGEJO_URL`：部署侧探活地址（`dependencyServices` 的 `addressKey`）。它是**部署面**
 *   口径而不是模块运行时口径：运行时地址来自连接配置的 `baseUrl`（可指向容器服务名），探针无法解析
 *   配置文件，只能锚定 env 键。容器内部署应设为 `http://forgejo:3000`，默认值对齐宿主回环端口。
 *
 * `dependencyServices`：Forgejo 取 `orchestration: "separate"`——编排入口是
 * `docker/git/docker-compose.yml`（由 `FENIX_FEATURE_GIT` 启停），本声明不重复定义容器。`required:
 * false`：Forgejo 不可达只降级 Git 能力，不阻断主服务存活（方案 §10 的健康检查分离）。
 *
 * `create` 惰性指向 `src/module.ts` 的组合根：registry 会被大量位置导入，不能在索引层就把适配器与
 * Drizzle 拖进模块图。
 */
export const moduleManifest = {
  id: "git",
  kind: "resource",
  dependsOn: [],
  capabilities: ["common.git"],
  envDefinitions: [
    {
      moduleId: "git",
      key: "AOS_GIT_CONFIG_FILE",
      schema: z.string().default(""),
      defaultValue: "",
      secret: false,
      restartRequired: true,
      description:
        "公共 Git 连接配置 JSON 的绝对路径（受运维管理，见 docs/operations/common-git.md 的配置样例）。" +
        "空串表示未配置：启用 git 模块但未配置时，装配在副作用前失败；未启用 git 的装配不读取该文件。",
    },
    {
      moduleId: "git",
      key: "AOS_GIT_PROVISION_TOKEN",
      schema: z.string().default(""),
      defaultValue: "",
      secret: true,
      restartRequired: true,
      description:
        "Forgejo 初始化凭据（建仓库、建 Webhook、绑定既有仓库时使用），只允许被 git-bootstrap 与管理接口消费。" +
        "禁止常驻在 AOS 请求处理路径上；密钥材料，禁止进日志、响应与错误文案。",
    },
    {
      moduleId: "git",
      key: "AOS_GIT_SERVICE_TOKEN",
      schema: z.string().default(""),
      defaultValue: "",
      secret: true,
      restartRequired: true,
      description:
        "Forgejo 日常读写凭据（受限服务账号，仓库绑定通过 {env:AOS_GIT_SERVICE_TOKEN} 引用它）。" +
        "密钥材料，禁止进日志、响应与错误文案。",
    },
    {
      moduleId: "git",
      key: "AOS_GIT_FORGEJO_URL",
      schema: z.string().default("http://127.0.0.1:3210"),
      defaultValue: "http://127.0.0.1:3210",
      secret: false,
      restartRequired: true,
      description:
        "Forgejo 部署侧探活地址（部署自检使用，不是模块运行时地址——运行时地址在 AOS_GIT_CONFIG_FILE 的 baseUrl）。" +
        "容器内部署设为 http://forgejo:3000；默认值对齐宿主回环端口，服务源码运行时可用。",
    },
  ],
  dependencyServices: [
    {
      id: "forgejo",
      required: false,
      orchestration: "separate",
      composeFile: "docker/git/docker-compose.yml",
      envKeys: ["AOS_GIT_FORGEJO_URL"],
      healthCheck: { kind: "http", addressKey: "AOS_GIT_FORGEJO_URL", path: "/api/healthz" },
      description:
        "共享 Forgejo 服务（仓库、Issue、评论、标签与附件的事实源）。由 FENIX_FEATURE_GIT 控制独立编排；" +
        "接入已有 Forgejo 时不启动本地容器。不可达只降级 Git 与工单能力，不阻断 AOS 启动。",
    },
  ],
  create: (context) => import("./src/module").then((module) => module.createGitModule(context)),
} satisfies ModuleManifest;
