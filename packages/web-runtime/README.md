# @fenix/web-runtime

宿主无关的 **web 运行时基础设施**包：各 `packages/**/web/**` 与宿主 `apps/web` 共用的 HTTP 客户端、
i18n 命名空间表、事件总线与 chat 投影层。本期从 `apps/web` 迁出，不做兼容层、不发布。

## 包定位

- 以 **TypeScript 源码**形式被消费方打包（`exports` 直指 `web/**/*.ts`），不做 lib build。
- 只收录**零领域语义、跨领域复用**的模块。任何带领域语义的模块（agent/model/skill 等）归各自资源包，
  不进本包；纯 UI 域模块归 `@fenix/ui-components`。
- 多租户、鉴权、路由、i18n **单例**、样式表等宿主职责一律不进入本包。

## 收录范围与出口

`exports` 用显式子路径逐个登记（仓库零通配符出口约定，参照 `resources/machine` 的 `./file-ws-handler`）：

| 出口 | 文件 | 职责 |
| --- | --- | --- |
| `@fenix/web-runtime/api/request` | `web/api/request.ts` | 统一 HTTP 客户端（credentials / 超时 / 错误标准化） |
| `@fenix/web-runtime/i18n/namespace` | `web/i18n/namespace.ts` | `NS` 常量表与 `Namespace` 类型 |
| `@fenix/web-runtime/lib/admin-key` | `web/lib/admin-key.ts` | 系统 Master Key 的 sessionStorage 读写（唯一实现） |
| `@fenix/web-runtime/lib/config-events` | `web/lib/config-events.ts` | 通用配置变更事件总线 |
| `@fenix/web-runtime/lib/artifacts-preview-events` | `web/lib/artifacts-preview-events.ts` | 通用文件预览事件总线 |
| `@fenix/web-runtime/lib/chat-stats` | `web/lib/chat-stats.ts` | `chat:stats` 摘要协议与节流派发器 |
| `@fenix/web-runtime/hooks/use-changed-files-stats` | `web/hooks/use-changed-files-stats.ts` | `chat:stats` 消费端投影 |
| `@fenix/web-runtime/hooks/use-page-visible` | `web/hooks/use-page-visible.ts` | `ChatPageVisibleContext` 保活可见性契约 |
| `@fenix/web-runtime/chat/structured-to-thread` | `web/chat/structured-to-thread.ts` | Chat Doc → `ThreadEntry` 投影层 |
| `@fenix/web-runtime/chat/todo` | `web/chat/todo.ts` | TodoWrite 快照解析与增量对比 |

**不建 barrel（`web/index.ts`）**：全部消费方都走深链，barrel 只会让只想用 `NS` 常量表的调用方
连带拉入 `structured-to-thread`（进而拉入 `yjs` / `i18next`）与 React hooks。零收益、纯风险，故不建，
也不在 `exports` 里登记 `"."`。

## 目录约定

```
web/                  源码；必须在 web/ 下（Tailwind @source 约定，见下）
  api/                HTTP 客户端
  i18n/               命名空间注册表（不含 i18next 单例）
  lib/                事件总线与 chat:stats 协议
  hooks/              React hooks
  chat/               chat 领域投影层
```

**为什么必须在 `web/` 下**：宿主 Tailwind 约定为「应用壳 + 各包源码所在的 `web/` 目录」一起扫描
（`apps/web/src/index.css` 的 `@source "../../../packages/**/web/**/*.{ts,tsx}"` 已自动覆盖本包）。
放到 `web/` 之外的工具类不会被扫描到，样式会被静默裁剪。

## 不搬清单（留在 `apps/web`，属宿主职责）

| 模块 | 原因 |
| --- | --- |
| `apps/web/src/i18n/index.ts` 的 i18next **单例**与 `.init()` | 语言检测、`localStorage("rcs-lang")`、`fallbackLng` 都是宿主启动决策；各包 locale 的注册也由宿主统一完成 |
| `apps/web/src/i18n/locales/**` | 宿主自有命名空间文案（common/sidebar/dashboard…） |
| `apps/web/src/index.css` 与设计 token | 样式入口属宿主应用壳 |

> 本包只搬走 `NS` 常量表：`NS` 是跨包命名空间契约，而单例是宿主运行时状态，两者必须分离，
> 否则 packages 的 web 前端会被迫依赖宿主启动模块。

## 为什么必须是顶层包，不能进 `packages/platform/`

`web/chat/structured-to-thread.ts` 依赖 `@fenix/chat-channel`（Chat Doc 读取 API 与
`StructuredMessage` 类型）。若本包放在 `packages/platform/` 下，会命中 `.dependency-cruiser.cjs` 的
`platform-not-to-agent-runtime-resources-apps` 规则——该规则禁止 `packages/platform/**` 依赖
`packages/agent-runtime/**`、`packages/resources/**` 与 `apps/**`，而 `@fenix/chat-channel` 属 agent 运行时侧。
因此本包与 `packages/ui-components` 同级，放在 `packages/` 顶层。

## 包内依赖

- 运行时依赖：`@fenix/chat-channel`（Chat Doc 访问）、`@fenix/ui-components`（chat 领域纯类型与
  `extract-changed-files` / `tool-semantic`，其实现已在 ui-components 完成抽取，本包不复制第二份）、
  `i18next`、`yjs`。
- `react` 为 peerDependency（hooks 与 context 由宿主渲染树提供实例，重复打包会导致 context 失配）。

## 迁移来源

2026-09-18 由 `apps/web` 迁出，见 `docs/design/2026-09-18-packages-web-ui-components-migration.md` 的
「Bucket C 归属表 / C1」：
`apps/web/src/{api/request.ts, lib/{config-events,artifacts-preview-events,chat-stats,structured-to-thread,todo}.ts,
hooks/{use-changed-files-stats,usePageVisible}.ts}` 与 `apps/web/src/i18n/index.ts` 的 `NS` 常量表。
实现逐字保留，仅修正包内跨模块引用路径。

2026-09-20 追加 `web/lib/admin-key.ts`：系统 Master Key 的 sessionStorage 助手原先只存在于宿主
`apps/web/src/lib/admin-key.ts`，资源包经 vite 别名 `@/src/lib/admin-key` 引用（observer 6 处、
model-management 2 处）。为切断资源包对 `@/` 宿主的依赖且不产生第二份实现，实现逐字迁入本包
（存储键 `rcs_admin_master_key` 不变），宿主副本随即删除，消费方改经 `@fenix/web-runtime/lib/admin-key`
深链引用。Master Key 的存档位置、回门时机与理由见 `docs/arch/21` §5。
