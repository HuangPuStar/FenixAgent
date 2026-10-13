# Assembly profiles

此目录保存随构建版本交付的静态模块组合。profile 只能选择已经编译进 `apps/generated/module-registry.ts` 的模块 ID，不能声明路径、URL、包名或代码入口。

`ce.json` 固定 CE 产品线选择的 access-control、Agent Runtime 和 Web Shell ID。registry 与 bootstrap 必须拒绝未知模块、类别不匹配及缺少工厂的基础模块。

## 字段与校验

| 字段 | 必填 | 校验 |
| --- | --- | --- |
| `identity` | 是 | 必须指向已注册的 `kind: "identity"` 模块 |
| `accessControl` | 是 | 必须指向已注册的 `kind: "access-control"` 模块 |
| `agentRuntime` | 是 | 必须指向已注册的 `kind: "agent-runtime"` 模块 |
| `webShell` | 是 | 必须指向已注册的 `kind: "web-shell"` 模块 |
| `resources` | 是 | 每项必须是已注册的资源模块 ID，按 `dependsOn` 拓扑排序 |
| `web` | 是 | 每项必须是已注册且服务端 owner 已启用的 web contribution ID（manifest `web.id`，不是 `web.contribution` 说明符）；构建期选择 bundle，运行期收窄前端能力 |

`webShell` 只做校验与绑定，**不进入服务端的 `modules` / `instances`**：Shell 由 `apps/web` 自行消费，server 不实例化它。对应的 manifest 是 `apps/web/fenix.module.ts`（`kind: "web-shell"`，纯元数据，只允许 `import type`）。

`web` 与 `webShell` 不同：`web` 列表在**构建期**由 `bun run generate:web-contributions` 读取本目录的 JSON profile（**只支持 JSON**），生成 `apps/generated/web-contributions.ts`，保留 `web.id` 与静态 import 的贡献载荷。**bundle 是上界，运行期只能收窄**：部署期 JSON/YAML profile 不会重新打包浏览器 bundle，但会通过宿主清单让前端关闭其中未启用的入口；不能启用 bundle 外的贡献。

## 运行期模块启用标识

宿主公开只读 `GET /web/system/modules`，响应 `{ success: true, data: { modules: string[], web: string[] } }`。`modules` 是当前装配的资源模块 ID（不含基础模块与 Shell），`web` 是已校验装配结果的 web ID；不返回入口说明符、URL、环境变量或任何配置值。此部署元数据不区分用户/组织，也不代替认证授权，不能挂在可选模块下。

浏览器根 Provider 用 `useRequest` 获取一次清单，导航与根路由出口共享该快照。有效 web 集合是构建期贡献与运行期清单的交集；导航再叠加 `hiddenTabs` 偏好，后者只隐藏入口，不禁止直达。贡献导航项 `/agent/<id>` 及子路径自动受统一路由边界保护，非导航入口由 owner 的 `routePrefixes` 一行声明；关闭时不挂载业务子树，显示「未启用」，加载中显示状态提示。

拉取失败（含非法响应）按构建期清单 fail-open，显示非阻断提示与重试按钮，并记录一次 `assembly_modules_fetch_failed` 结构化错误信号，不输出原始异常或响应。清单是当前浏览器应用生命周期的快照，部署变更后需重新打开/刷新应用；端点禁止 HTTP 缓存。部署滚动更新应保证请求落在一致 profile 的后端集合。

例如关闭新工作流：从部署 profile 的 `resources` 移除 `workflow-v2`，同时从 `web` 移除 `workflow`（两种 ID 不同），重启服务。未移除 web 引用会按既有 registry 规则启动失败，而非悄悄修正。`apps/server/src/__tests__/fixtures/assembly-without-workflow.json` 用于前后端测试示范，默认 `ce.json` 不变；旧 `workflow` 资源模块与新 `workflow-v2` 是独立模块，本机制不改变旧 API。

`docker/deploy.env` 的 `FENIX_FEATURE_*` 仍属于部署服务开关，不自动映射装配 profile。长期决策见 `docs/adr/2026-10-08-assembly-capability-gate.md`。

## 与生成 registry 的关系

profile 是「目标组合」，registry 是「已编译进镜像的模块清单」。二者必须同时满足：profile 选择了未注册的 ID 会在启动时抛错，而不是静默降级到某个默认实现。新增模块的流程是提供 package + manifest，再运行 `bun run generate:module-registry`（声明了 `web` 的模块还需 `bun run generate:web-contributions`），不需要改 app 的注册逻辑。

profile 可随镜像交付，也可作为受部署平台保护的只读挂载文件在启动时读取；**位置由部署面给出**：不带
`RCS_ASSEMBLY_PROFILE_PATH` 时是应用根下的 `deploy/assembly/ce.json`（CE 入口的固定 profile），换文件用该键
传绝对路径（相对路径会随启动 cwd 漂移，启动期即被拒绝）。无论 profile 从哪里来，它自己都不能指定路径，
也不能声明模块路径、URL、包名或代码入口。
