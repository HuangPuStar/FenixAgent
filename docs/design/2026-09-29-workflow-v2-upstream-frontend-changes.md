# Workflow V2：上游前端改造记录（1F）与 1G/1H 可行性评估

> 日期：2026-09-29 · 状态：**1F 已实施（未提交）**；1G/1H 为评估结论（未动代码）
> 设计依据：[2026-09-29-workflow-v2-upstream-studio-bridge.md](./2026-09-29-workflow-v2-upstream-studio-bridge.md)（§5、§5.5）、[2026-09-29-workflow-v2-interface-freeze.md](./2026-09-29-workflow-v2-interface-freeze.md)（§7）
> 改造仓库：`/Users/konghayao/code/ai/workflow-studio`（上游工作流引擎）。只改 `frontend/**`，未新增任何依赖，未提交 commit。

## 1. 1F 实施记录（画布请求改道到 fenix BFF）

### 1.1 文件清单

| 文件（相对上游仓根） | 类型 | 说明 |
|---|---|---|
| `frontend/packages/arch/bot-http/src/host-bridge.ts` | 新增 | 宿主桥：postMessage 握手、票据持有、API 基址决策 |
| `frontend/packages/arch/bot-http/src/axios.ts` | 修改 | 请求拦截器注入基址与票据头；401 分支改为向宿主换票并重放一次 |
| `frontend/packages/arch/bot-http/__tests__/host-bridge.test.ts` | 新增 | 桥的 11 个用例（惰性、握手、幂等、超时、来源校验、URL 参数） |
| `frontend/packages/arch/bot-http/__tests__/axios-embedded.test.ts` | 新增 | 嵌入场景 axios 的 4 个用例（基址+票据头、401 换票重放、换票失败上报、非嵌入不变） |

改动全部落在 bot-http 包内，`axios.ts` 只调用 `host-bridge`，无散落改动。

### 1.2 实现摘要

1. **API 基址注入**（`axios.ts:257-266`）：请求拦截器按 `getApiBaseUrl()` 覆盖 `config.baseURL`。基址来自宿主下发的 URL 参数（`?apiBase=/workflow-canvas/bff`，`host-bridge.ts:361`）或 `bind` / `token` 消息载荷；未提供时保持 `undefined`，axios 行为与改造前完全一致。
2. **票据请求头**：每个请求带 `X-Fenix-Workflow-Ticket`（`host-bridge.ts:39`）。票据仅在内存持有，不入 cookie / storage / URL；`signout` 时清空。
3. **401 处理**（`axios.ts:193-220`）：
   - 非嵌入（上游独立运行）：仍然 `redirect(redirect_uri)` 整页跳转，行为不变；
   - 嵌入：向宿主发 `{v:1,id,type:"refresh-request",ts,payload:{reason:"unauthorized"}}` 并等待 `type:"token"`（10s 超时，`host-bridge.ts:48`），拿到票据后**重放一次**原请求；换票失败或重放仍失败，向宿主发 `type:"error"`（含 `code` / `retryable`，只带 HTTP 状态码，不回传 URL 与参数）。并发 401 合并为一次换票（`host-bridge.ts:144`）。
4. **换票重放走独立 axios 实例**（`axios.ts:165-186`）：`axiosInstance` 的响应链上还挂着下游拦截器（`packages/arch/bot-api/src/axios.ts:40` 的 `response => response.data`），重放结果若再进一遍链会被二次解包，因此重放用无拦截器实例 + 手动复用 `processResponse`，保证与正常链路同一套解包与报错语义。
5. **一次性 code 兑换幂等**（`host-bridge.ts:240-262`）：宿主在收到 `bound` 前会按 500ms 重试 `bind`，同一 code 可能被重复下发；code 单次消费，重复兑换只会失败并让宿主误判握手失败。因此票据在手时直接回报 `bound {ok:true}`，并发下发共享一次请求。
6. **构建标识**（`host-bridge.ts:397`）：`CONSUMER_BUILD_VERSION` / `CUSTOM_VERSION` 是 rspack `source.define` 注入的**构建期常量**，define 的键是裸标识符（实测产物中已无该名字，说明裸标识符引用在打包时被替换）；写成 `globalThis.X` 属于属性访问，不在替换范围内、运行时恒为 `undefined`。改用裸标识符 + `typeof` 守卫，非打包环境（vitest）返回 `undefined` 而不抛错。
7. **握手启动**：模块加载即启动（`host-bridge.ts:415`），仅嵌入场景生效——不挂 message 监听、不发消息、不读 URL 参数。子→父消息固定 `targetOrigin = window.location.origin`，只接受 `event.source === window.parent` 且 `event.origin === 同源` 的消息，`apiBase` 拒绝协议相对地址（`//host`）。

### 1.3 需要同步进冻结文档的点

- `apiBase` 参数目前只在本实现的注释里：既是 iframe URL 参数，也是 `bind` / `token` 载荷字段。建议补进 interface-freeze §7（消息载荷）与 §5.2（iframe URL）。
- 设计文档 §5.5 表格里写的 `postMessage('auth-expired')` 与冻结 §7 的消息类型集合（`ready|bind|bound|refresh-request|token|navigate-out|error|resize|theme|locale|ping|pong`）冲突；1F 按 §7 实现为 `refresh-request` → `token`，建议把 §5.5 那一行改成同一口径。
- iframe URL 参数名需要统一：设计文档写 `?wf=..&view=canvas|test-run&locale=`，而上游画布入口实际从 query 读 `workflow_id` / `space_id`（`frontend/packages/workflow/adapter/playground/src/hooks/use-page-params.ts:51`），i18n 检测器读的是 `lng`（见 §3.3）。建议明确「谁做参数映射」。
- 依赖约束：BFF 的票据失败必须是**真实 HTTP 401**（冻结 §6 已如此规定），画布侧只按 `error.response.status === 401` 触发换票；若改成 200 + `{code:401}` 会走业务错误分支、不触发换票。

### 1.4 验证命令与结果

在 `frontend/packages/arch/bot-http` 下执行：

| 命令 | 结果 |
|---|---|
| `npx tsc -b tsconfig.build.json --force` | **退出码 0**（src 干净；改动前后一致，均为 0） |
| `npx tsc -b tsconfig.json --force` | 退出码 2，输出与 `git stash` 后的 HEAD 结果**逐字节一致**；12 个错误全部既有，且不在改动文件内：11 个在 `__tests__/global-interceptor.test.ts`（未改动），1 个在 `config/vitest-config/src/preset-default.ts`（依赖包 rollup 类型冲突） |
| `NODE_ENV=test npx vitest --run` | **6 文件 / 39 用例全部通过**（其中 15 个为本任务新增：host-bridge 11 + axios-embedded 4） |
| `npx eslint src __tests__` | 0 error；8 个 warning 全部既有——`src/axios.ts` 6 个与 HEAD 逐条一致（同规则同行序语义，未新增），`src/api-error.ts` 2 个为未改动文件；`host-bridge.ts` 与两个新测试文件 0 warning |

说明：包根 `tsconfig.json` 是 `composite` + `exclude: ["**/*"]` 的引用壳，`npx tsc --noEmit` 不检查任何文件，类型检查必须用 `tsc -b`（`tsconfig.build.json` 查 src，`tsconfig.json` 连 `__tests__` 一起查）。

### 1.5 覆盖边界（已核查，供 1G/1H 使用）

- 画布 API 流量确实经过被改造的实例：`packages/arch/bot-api/src/workflow-api.ts:26` 的 `request` 最终调用 `axiosInstance.request(...)`，IDL 生成的 `WorkflowApiService` 全量经此出网。
- `packages/workflow/**` 内没有裸 axios 请求（仅用 `axios.CancelToken`），无 SSE / `fetch` 请求路径，未发现绕过 `axiosInstance` 的调用方。

## 2. 上游前端构建方式摘要

```text
make fe
  └─ scripts/build_fe.sh
       ├─ source scripts/setup_fe.sh        # 校验 node / rush，安装 rush
       └─ cd frontend && BUILD_BRANCH=opencoze-local rush rebuild -o @coze-studio/app --verbose
            └─ @coze-studio/app 的 build 脚本：IS_OPEN_SOURCE=true rsbuild build
                 ├─ 配置：frontend/apps/coze-studio/rsbuild.config.ts
                 └─ 产物：frontend/apps/coze-studio/dist/
       └─ 复制 dist/* → backend/static/ 与 bin/resources/static/（Go 服务内嵌静态资源）
```

- 构建期注入（1G/1H 的关键）：`source.define` 由 `frontend/config/rsbuild-config/src/index.ts:28` 的 `getDefine()` 把 `@upstream-arch/bot-env` 的 `GLOBAL_ENVS` 逐键展开；`output.assetPrefix` 由同文件 `generateCdnPrefix()`（`:49-56`）决定，`CDN_INNER_CN` 未设置时为 `'/'`。
- 应用级配置可与基础配置合并：`defineConfig` 末尾是 `mergeRsbuildConfig(config, options)`（`:142`），`apps/coze-studio/rsbuild.config.ts` 传入的 `options` 优先级更高，是覆盖 `output` 的合法位置。
- 现状佐证：已构建的 `apps/coze-studio/dist/index.html` 里资源是全绝对路径（`/static/js/...`、`/favicon.png`），子路径挂载会直接 404。

## 3. 1G 可行性评估（I18n/Theme 自举、space 与用户态注桩、全局常量兜底）

### 3.1 结论

采用「整包 SPA 挂在 `/workflow-canvas` 子路径」方案时，**1G 实际范围比 §5.5 清单小**：Provider 与全局常量已由应用壳和构建管线提供，真正要做的是「去掉登录依赖」与「space/用户态注桩」，预估 **S~M（1-2 天）**，无架构性阻塞。

### 3.2 现状事实（逐条有据）

| 事项 | 现状 | 证据 |
|---|---|---|
| 主题 Provider | 已由应用壳提供，画布无需自举 | `packages/foundation/global-adapter/src/components/global-layout/index.tsx:58`（`ThemeProvider` 包裹 Layout） |
| i18n | **模块单例**，非 React Provider：画布内 `I18n.t(...)` 2232 处、`useTranslation` 0 处 | `packages/arch/i18n/src/raw/index.ts:30` 的 `initI18nInstance`，应用入口 `apps/coze-studio/src/index.tsx:37` 调用一次 |
| 语言来源 | i18next `LanguageDetector` 顺序 `querystring(lng) → cookie → localStorage → navigator`，宿主带 `?lng=zh-CN` 即可锁定，**无需改代码** | `packages/arch/i18n/src/raw/index.ts:36-50` |
| 全局常量 | 是**构建期 define**（`source.define`），不是运行时 `window` 全局；只要走同一 rsbuild 管线就不会缺 | `frontend/config/rsbuild-config/src/index.ts:28`、`:113`；`IS_BOT_OP` 恒为 `false`（`packages/arch/bot-env-adapter/src/base.ts:46`） |
| 登录闸门 | 路由级 `requireAuth` 驱动：`useCheckLogin({ needLogin: requireAuth && !requireAuthOptional })` | `packages/foundation/global-adapter/src/hooks/use-app-init/index.ts:38-44`；`work_flow` 路由 `requireAuth: true`（`apps/coze-studio/src/routes/index.tsx:254-262`） |
| space 初始化 | 未 `inited` 时 `fetchSpaces(true)` → 调 `PlaygroundApi.GetSpaceListV2`；失败则 `inited` 一直 false，画布直接 `return null`（白屏） | `packages/workflow/playground/src/workflow-playground.tsx:81-108`、`packages/foundation/space-store-adapter/src/space/index.ts:162-217` |
| space 一致性 | `setSpace(id)` 在 id 不在 `bot_space_list` 时**抛错**，`checkSpaceID` 依赖同一列表 | `packages/foundation/space-store-adapter/src/space/index.ts:116-128` |
| 用户态 | 调试运行/发布等消费 `useUserInfo`（`userStoreService` 或 `@upstream-arch/foundation-sdk`） | `packages/studio/user-store/src/index.ts:37`；`packages/workflow/playground/src/components/test-run/hooks/use-testset-biz-ctx.ts:29` |

### 3.3 建议改法（按优先级）

1. **去掉登录闸门**：给画布路由设 `requireAuth: false`（或以嵌入判定动态给），不要改 `useCheckLogin` 本身，避免影响上游自身的登录语义。
2. **space 注桩**：嵌入分支下跳过 `fetchSpaces`，直接写入 `{ inited: true, spaces: { bot_space_list: [平台 space], has_personal_space: true, ... }, spaceList: [...] }`。必须保证 stub 的 space id 同时满足 `checkSpaceID` 与 `setSpace`，否则会在 `setSpace` 抛 `can not find space`。建议把分支放在 `workflow-playground.tsx` 的初始化 useEffect，不污染 `space-store` 的通用逻辑。
3. **用户态注桩**：`useUserInfo` 的消费点（test-run、publish、workflow-edit）需要最小 user stub；这是唯一需要逐点确认的部分（未逐点核查是否被权限组件强依赖）。
4. **语言/主题**：宿主 iframe URL 带 `lng=`（已有检测器支持）与主题参数，画布侧读取后应用；无需新增 Provider。

### 3.4 阻塞与风险

- `requireAuth` 是**路由级**配置，改动会影响同路由的非嵌入访问，必须用嵌入判定分支，避免上游独立运行时也失去登录保护。
- space stub 与 `setSpace` / `checkSpaceID` 的耦合是最容易踩的坑（见上表）。
- `workflow-playground.tsx:70` 有一行遗留 `console.log('debugger workflow playground')`，属上游侧既有噪音，建议在 1G 一并清理（不影响功能）。

## 4. 1H 可行性评估（路由 basename 与资源前缀）

### 4.1 结论

技术可行、改动面小（2 个源文件 + 1 个构建变量），但 **basename 与 assetPrefix 必须同时改，缺一即白屏**；残余风险集中在静态资源绝对路径与 SPA 回退（回退属 1E 反代职责）。预估 **S（0.5-1 天）**。

### 4.2 需要改的位置

| 项 | 位置 | 现状 | 建议 |
|---|---|---|---|
| 路由 basename | `apps/coze-studio/src/routes/index.tsx:51` | `createBrowserRouter([...])` 无第二参数 | `createBrowserRouter(routes, { basename: ROUTER_BASENAME })` |
| 资源前缀 | `frontend/config/rsbuild-config/src/index.ts:49-56`（`generateCdnPrefix`）、`:100-102`（`output.assetPrefix`） | 仅 `CDN_INNER_CN`（绝对 CDN 域名）或 `'/'`；产物里是 `/static/js/...` | 不要复用 `CDN_INNER_CN`（会得到绝对 URL）；在 app 级覆盖成相对前缀 |
| 覆盖点 | `apps/coze-studio/rsbuild.config.ts` | 目前只配了 server.proxy / html / tools / source | 在此传 `output.assetPrefix`（合并顺序保证 app 覆盖优先生效，见 §2） |
| 构建变量入口 | `apps/coze-studio/package.json` 的 `build` 脚本、`scripts/build_fe.sh` | `IS_OPEN_SOURCE=true rsbuild build` | 新增一个构建期变量（如 `WORKFLOW_CANVAS_BASE=/workflow-canvas/`），默认 `'/'` 保持独立部署不变 |
| 开发态 BFF 代理 | `apps/coze-studio/rsbuild.config.ts:29-42` | 只代理 `/api`、`/v1` | 加 `/workflow-canvas/bff` → workflow-v2，供画布本地联调 |

### 4.3 建议改法

1. 引入单一变量 `WORKFLOW_CANVAS_BASE`（默认 `/`）：
   - `output.assetPrefix = WORKFLOW_CANVAS_BASE`；
   - `source.define` 增加 `ROUTER_BASENAME`，`routes/index.tsx` 用它做 basename。
2. `ROUTER_BASENAME` 在非打包环境（vitest）用 `typeof` 守卫取值，避免 ReferenceError（与 1F 的构建标识同一手法）。
3. favicon 等模板资源由 rsbuild 按 `assetPrefix` 重写，**不需要单独改** `index.html` 模板（模板里没有硬编码资源）。
4. 打包命令改为 `WORKFLOW_CANVAS_BASE=/workflow-canvas/ IS_OPEN_SOURCE=true rsbuild build`（或在 `build_fe.sh` 里导出），产物仍是同一份 SPA，独立部署不受影响。

### 4.4 验收与阻塞

- 验收（建议进阶段 0 核销清单）：`/workflow-canvas/work_flow?...` 直达与刷新都不 404（依赖 1E 的 SPA 回退规则）；动态 chunk 从 `/workflow-canvas/static/js/` 加载；字体/图片/less 内 `url()` 无绝对根路径；favicon 与图标正常。
- 阻塞：无结构性阻塞；唯一需要实测的是「整包产物里是否存在写死根路径的资源引用」（未逐文件核查，交给运行时核销）。

## 5. 风险与待办

1. **协议文档缺口**：`apiBase` 未进冻结文档；iframe URL 参数名（设计写 `wf`/`view`/`locale`，上游实际读 `workflow_id`/`space_id`/`lng`）需要明确映射责任方。
2. **文档冲突**：§5.5 的 `auth-expired` 与 §7 的 `refresh-request`/`token` 不一致，1F 已按 §7 实现，建议同步修正 §5.5。
3. **换票超时**：画布侧 10s 硬编码（`host-bridge.ts:48`），建议与 `WORKFLOW_V2_IFRAME_TICKET_TTL_SECONDS`（默认 900s）的续期策略一起复核，避免宿主换票慢时误判失败。
4. **1G 用户态**：`useUserInfo` 消费点未逐点核查，是 1G 唯一可能超出 1-2 天预估的部分。
5. **1H 静态资源**：绝对路径引用需运行时核销（见 §4.4）。
6. **本仓状态提示**：上游工作区中 `docker/docker-compose-debug.yml` 存在与 1F 无关的本地改动（MinIO → RustFS），未纳入本次范围，提交前需与 1F 分离。

## 6. 增量改造：嵌入态恢复左侧常驻节点面板（1F-2）

> 日期：2026-09-29 · 状态：**已实施（未提交）**；改动仍只落在 `frontend/**`，未新增依赖
> 目的：上游把节点入口收敛到顶部工具栏 + 弹层后，嵌入态左侧常驻的节点 block 列表消失（宿主侧既有交互习惯被打破）。本增量在**嵌入态**恢复该栏，与弹层**共存**，两条入口共用同一份节点清单与同一套添加链路。

### 6.1 文件清单

| 文件（相对上游仓根） | 类型 | 说明 |
|---|---|---|
| `frontend/packages/workflow/playground/src/components/node-sidebar/index.tsx` | 新增 | 嵌入态左侧常驻节点面板：数据源复用 `useTemplateNodeList()`（与弹层 `NodeList` 同一条链，含嵌入白名单过滤），条目复用 `AtomCategoryList`（`NodeCategoryPanel` + `CustomDragCard`），拖拽走 react-dnd（`DND_ACCEPT_KEY`），落到画布后仍由 `AddNodeModalProvider` 承接添加；非嵌入态返回 null |
| `frontend/packages/workflow/playground/src/components/node-sidebar/index.module.less` | 新增 | 228px 单列窄栏（优先保画布可用宽度）；在侧栏作用域内把弹层的双列网格与 204px 固定卡片宽度收成单列整行（属性包含匹配，兼容 dev/prod 类名） |
| `frontend/packages/workflow/playground/src/index.tsx` | 修改 | 包出口新增一行 `export { NodeSidebar }`（adapter 包经 `@coze-workflow/playground` 取用，不新增 exports 子路径） |
| `frontend/packages/workflow/adapter/playground/src/page.tsx` | 修改 | `sidebar` 从 `EmptySidebar` 换成 `NodeSidebar`；删除 `EmptySidebar` 及随之无用的 `AddNodeRef` 导入 |

### 6.2 关键决策与约束

1. **非嵌入态 gate 放在组件内**（`NodeSidebar` 内 `isEmbedded()` 为 false 即返回 null），而不是在 `page.tsx` 写 `isEmbedded() ? NodeSidebar : EmptySidebar`：adapter 包**未声明** `@coze-arch/bot-http` 依赖（pnpm 下 phantom import 解析不到；同仓先例 `apps/coze-studio/src/routes/index.tsx:76-78` 有同样说明），而 playground 包已依赖该包，判据与 `utils/embedded-node-scope.ts` 同源。渲染结果与 `EmptySidebar` 等价（非嵌入为 null）。
2. **侧栏不写 `addNodeRef`**（不实现 `useImperativeHandle`）：容器把同一个 ref 同时挂在 `<Sidebar>` 与 `<AddNodeModalProvider>` 上（`components/workflow-container/index.tsx:105,232-233`），画布 drop 依赖 provider 写出的 `handleAddNode`；侧栏渲染序在前，若也写 ref 会与 provider 争用同一 ref，故只渲染列表。
3. **已知缺口（最小实现）**：`Api` / `SubWorkflow` / `Imageflow` 的**点击**添加在上游走弹层（`node-panel/components/panel.tsx:164-219` 的 `openPlugin` / `openWorkflow` / `openImageflow`），依赖 `AddNodeModalProvider` 的 context，而侧栏与 provider 是兄弟节点、拿不到该 context；这三类节点同时不在嵌入白名单内（当前数据链路不可达），故侧栏对它们不做点击添加，代码内已注释缺口描述、影响范围与移除条件（把侧栏移进 provider 子树后按 panel.tsx 分支补齐）。**拖拽入口不受影响**（拖拽经画布 drop → provider，链路完整）。
4. **宿主侧 iframe 最小宽度无需调整**：侧栏 228px 占位后，1200px 的 iframe 内画布文档宽度与视口一致（无横向溢出），五档视口（1440/1280/1100/1024/900）下宿主页面亦无横向滚动回归，故未改 `packages/resources/workflow-v2/web/pages/canvas/canvas-host-page.tsx` 的 `min-w-300` 常量。

### 6.3 上游同步冲突处理提示

- 上游若**自行恢复**左侧 sidebar（或再次调整 `workflow-container/index.tsx` 的 `sidebar` 渲染条件、`EmptySidebar` 的用法），直接采用上游实现并撤掉本增量即可：`adapter/playground/src/page.tsx` 的 `sidebar={NodeSidebar}` 与 `playground/src/index.tsx` 的导出一并回退。
- `NodeSidebar` 依赖上游三处实现细节，升级时需核对：① `CustomDragCard` 的 DOM 分层（`data-testid` 在外层容器、`draggable` 在 drag 层子节点）；② `node-panel` 的样式类名（`node-category-list` / `node-card`，侧栏样式覆盖用属性包含匹配，类名改名后侧栏会退回双列布局）；③ `useTemplateNodeList()` 的签名与白名单过滤链（`utils/embedded-node-scope.ts`，未放宽）。
- 侧栏宽度（228px）与单列覆盖写在 `node-sidebar/index.module.less`；上游若改动卡片尺寸或网格类名，需同步调整。

### 6.4 验证（摘要）

宿主侧用临时实例（`RCS_PORT=3111`，`WORKFLOW_CANVAS_UPSTREAM_URL` 指向上游生产构建产物的静态服务）与改动前（默认上游 18080 的旧产物、`RCS_PORT=3112`）跑同一组浏览器探针对照：侧栏出现且清单与顶部弹层逐条一致（10 条，全部命中嵌入白名单）；**拖拽**（react-dnd 原生 DnD 事件序列）与**点击**都能把节点落到画布（同一次运行：2 → 3 → 4）；端点集合与失败请求数与改动前逐条一致（无新增端点、无 4xx/5xx）；五档视口无横向溢出回归；顶层窗口（非嵌入态）无侧栏且 DOM 与改动前一致（该场景受「上游登录凭证不在本仓」限制，页面停在登录页，属弱对照）。上游改动包：`eslint` 0 error、`vitest` 38/38 通过（playground 包 6 个文件）、生产构建通过。

## 7. 生效与部署（上游前端产物 → 本机 18080 opencoze）

> 日期：2026-09-29 · 状态：**已部署并实测通过**；本次对应上游提交 `67227c0b`（NodeSidebar）
> 用途：此后每次上游前端改动，按本节复用同一套「构建 → 替换 → 核验」流程，本仓无需改代码、无需重启服务。

### 7.1 构建与产物

在上游仓执行 `scripts/build_fe.sh`（内部为 `WORKFLOW_CANVAS_BASE=/workflow-canvas/ rush rebuild -o @coze-studio/app`），产物在 `frontend/apps/coze-studio/dist`。

### 7.2 部署目标

上游仓的 `bin/resources/static` 与 `backend/static` 两个目录，内容相同，**两个都要替换**。

### 7.3 替换步骤（无需重启）

`bin/` 下运行的 `./opencoze`（HTTP 18080）直接读盘，替换文件后即生效，不需要重启进程。两个目标目录各做一次，下例以 `bin/resources/static` 为例：

```bash
cd /Users/konghayao/code/ai/workflow-studio
TS=$(date +%Y%m%d-%H%M%S)

cp -R frontend/apps/coze-studio/dist/. bin/resources/static.new/        # 1) 暂存新产物（同盘）
mv bin/resources/static /Users/konghayao/code/ai/.wf-static-backup-$TS  # 2) 旧目录改名备份（仓外同盘）
mv bin/resources/static.new bin/resources/static                        # 3) 原子切换
```

- 本次备份目录为 `/Users/konghayao/code/ai/.wf-static-backup-<时间戳>`；**回滚 = 反向 `mv`**（把备份改回 `static`），无需重新构建。
- 旧目录整体移走而不就地覆盖，即为「清空」，避免 `index.html.hertz.gz` 等预压缩残留继续被命中。
- 产物资源 hash 变化后，浏览器需**硬刷新**。

### 7.4 验证

```bash
md5 -q frontend/apps/coze-studio/dist/index.html
curl -s http://127.0.0.1:18080/ | md5
```

两条命令输出一致即替换生效（本次实测一致）。`/workflow-canvas/*` 裸请求返回 **401 属预期**：上游鉴权中间件拦截，认证材料由宿主 BFF 注入，与部署是否生效无关。

## 8. 增量改造：嵌入态不挂一次性交互引导浮层（1F-3）

> 日期：2026-09-29 · 状态：**已实施、已构建、已部署到本机 18080、浏览器实测通过**；上游提交见 §8.6
> 触发缺陷：嵌入态下「点击画布节点，右侧详情/编辑面板不出现」。浏览器级取证结论：画布中央的一次性引导浮层（guiding-content）压在节点上方，接住了真实鼠标点击，节点 `onClick` 不触发。

### 8.1 引导浮层的实现与显隐条件（逐条有据）

| 事实 | 位置 |
|---|---|
| 浮层组件本体：`GuidingPopover`（semi `Popover`，`trigger="custom"`、`position="top"`）+ 内容 `GuidingContent` | `frontend/packages/components/mouse-pad-selector/src/with-guiding-popover.tsx:38-83`、`:85-129` |
| 浮层样式：`.guiding-content` 固定 **277px** 宽（实测渲染高 288px） | `frontend/packages/components/mouse-pad-selector/src/with-guiding-popover.module.less:1-4` |
| 应用内唯一挂载点（`stories/` 的 storybook 示例不计）：工具栏「交互模式」按钮被它包起来 | `frontend/packages/workflow/playground/src/components/toolbar/components/interactive.tsx:55-96`（改造前） |
| **显示条件**：`localStorage['show_workflow_interactive_type_guide'] !== 'true'` | `with-guiding-popover.tsx:98` → `src/utils.ts:42-45`；key 常量 `src/constants.ts:18` |
| **关闭方式（持久化）**：只有点浮层里的「Got it」→ 写 `localStorage[…]='true'`，此后不再出现 | `with-guiding-popover.tsx:102-105` → `src/utils.ts:38-40` |
| **关闭方式（不持久化）**：`onClickOutSide` 只置组件 state，刷新/重进即复现 | `with-guiding-popover.tsx:99`、`:124` |

**由此可解释缺陷**：浮层是**一次性、可关闭、关闭后持久化**的引导；它锚在画布底部工具栏按钮上（`position="top"`），向上展开后正好落在画布中部，压住中央节点。用户去点节点时点击被浮层内部接住 → `onClickOutSide` 不触发（点在浮层里，不是「外部」）→ 只能先点「Got it」才能操作节点，表现为「点节点没反应」。清站点数据、换浏览器、新访客都会复现，因此不是「每人只遇到一次就自愈」的问题。

修复前实测几何：浮层 wrapper `x=361 y=374 w=277 h=288`，与中央节点（Start，中心 `cx=473 cy=499`）重叠；`elementFromPoint` 命中 `p.semi-typography.guiding-content-desc-*`。修复后同位置命中节点内部 `span`。

### 8.2 方案选型

| 方案 | 结论 | 理由 |
|---|---|---|
| **甲：嵌入态不渲染该引导**（采用） | ✅ | 与既有嵌入态「收敛装饰性 UI」同一模式（`components/node-sidebar/index.tsx:129-134`、判据先例 `utils/embedded-node-scope.ts:18` 的 `isEmbedded()`）；只影响嵌入态，上游独立部署行为不变；改动 1 个文件 |
| 乙：保留引导但不拦截点击（挪位 / `pointer-events`） | ❌ | 治标：引导仍占着画布、仍需可关闭；位置不固定（两次实测工具栏按钮 x 从 388 变到 491，浮层随之移动），要动的是通用于独立站的组件包 |
| 丙：宿主侧预置「已引导」标记 | ❌ | iframe 与宿主同源，理论上可写 localStorage，但①与 iframe 加载有竞态（写之前浮层已渲染）；②语义上是替用户标记「已读过引导」，清数据后复现；③要改本仓宿主页/服务端，与并发中的其他本仓改动冲突面更大 |

### 8.3 文件清单（上游，1 个文件）

| 文件（相对上游仓根） | 类型 | 说明 |
|---|---|---|
| `frontend/packages/workflow/playground/src/components/toolbar/components/interactive.tsx` | 修改 | 工具栏按钮 JSX 抽成 `interactiveSelector` 变量；`isEmbedded()` 为真时直接返回它，否则沿用 `<GuidingPopover>` 包装（非嵌入态＝原行为）。`isEmbedded` 来自 `@coze-arch/bot-http`，playground 已声明该依赖（`package.json:49`），未新增依赖；diff 中绝大多数行是缩进位移 |

### 8.4 部署（按 §7 流程）

- 构建：上游仓 `WORKFLOW_CANVAS_BASE=/workflow-canvas/ rush rebuild -o @coze-studio/app` → `frontend/apps/coze-studio/dist`，新 `index.html` md5 `ec0dd5f0bfc9d8b44ee3519980e47b7f`（改前 `9f987f30fefff77f652d4d7165758ac7`）。
- 替换：`bin/resources/static` 与 `backend/static` 各自「暂存 `.new` → 旧目录整体 `mv` 到仓外同盘备份 → 原子改名」；本次备份目录 `/Users/konghayao/code/ai/.wf-static-backup-20260930-144059/{bin-resources-static,backend-static}`（**回滚 = 反向 mv**）。
- 核验：`dist` / `bin` / `backend` / `curl -s http://127.0.0.1:18080/ | md5` **四处一致**；opencoze 读盘即生效，未重启。
- 产物含修复：`static/js/async/5877.*.js` 中工具栏交互组件为 `return isEmbedded() ? selector : <GuidingPopover>{selector}</GuidingPopover>`。

### 8.5 浏览器级验收（宿主 3000 → iframe `/workflow-canvas/work_flow?...`，视口 1600×900）

- **无浮层**：`[class*='guiding-content']` 命中 0 个、可见 `semi-popover-wrapper-show` 0 个。
- **真鼠标点击（`page.mouse`，无 actionability 兜底）**：点 Start 节点中心（page 635,472）→ 右侧 `node-side-sheet` 出现（`x=1000 y=64 w=360`，文案 “StartThe starting node of the workflow…”）、`node-render … selected` 出现、`elementFromPoint` 命中节点内 `span`（`inNode: true`）。
- **回归**：侧栏仍在（`[data-testid='workflow.detail.node-sidebar']` 1 个、卡片 10 张、拖拽层 `[draggable=true]` 10 个）；侧栏点击添加成功（节点数 +1，验证后已删除还原）。
- **无新增错误**：全程 4xx/5xx = 0，console error = 0。
- 证据产物：`/tmp/wf2-stage/guiding-accept.json`、`guiding-accept-before.png`、`guiding-accept-clicked.png`、`guiding-restore.json`、`guiding-restore-after-reload.png`。
- **覆盖边界**：侧栏**拖拽**未做 DnD 事件序列回放（本次改动不触及侧栏 DnD 链路，上一轮 §6.4 已覆盖；本次仅验证拖拽层 DOM 存在）。另注意：同一次浏览器会话里先做 `dragTo` 中断会让 react-dnd 残留拖拽态，后续 click 会被当成 drop 落成新节点，回归脚本应把拖拽与点击拆到不同会话。

### 8.6 数据还原与提交

- 诊断探针曾给工作流 `7691150426783088640`（“布局排查用例”，本仓早前探针自建的一次性用例，非用户数据）加过 1 个 LLM 节点并被 autosave 持久化；本次按画布操作（选中节点 → `Delete`，键位见上游 `packages/workflow/render/src/layer/shortcuts-layer.tsx:40-47` 的 `WorkflowCommands.DELETE_NODES`）删除，**重载后该工作流只剩 Start + End 两个节点**（与探针介入前的 `cardBefore=2` 一致）。同次回归新增的节点一并删除。
- 上游仓单独提交（1 个文件）；本仓只改本文件。

### 8.7 上游同步冲突处理提示

- 上游若给 `GuidingPopover` 增加受控显隐 / 嵌入态感知，或把引导改成非遮挡形态（居中卡片、无遮罩层），本增量可**直接撤掉**：`interactive.tsx` 恢复成 `return (<GuidingPopover>…</GuidingPopover>)` 即可，无需其他改动。
- `isEmbedded()` 的判定源在 `@coze-arch/bot-http`；若上游改动该 API 名称或语义（`utils/embedded-node-scope.ts`、`components/node-sidebar` 与本处共 3 个使用点），三处需同步。
- 若上游把「交互模式」按钮移出工具栏或改掉 `data-testid="workflow.detail.toolbar.interactive"`，本文档的几何证据会失效，但结论（浮层锚在工具栏按钮上、向上展开覆盖画布）与修复方式不受影响。

