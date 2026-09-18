# @fenix/ui-components

从 `apps/web` 抽取并纯化的通用 React UI 组件包，自带一个最小 Vite 展示页（demo）。本期只产出可消费的源码包，
不接入任何消费方、不做兼容层、不发布。

## 包定位

- 组件以 **TypeScript 源码**形式被消费方打包（`exports` 直指 `web/**/*.ts(x)`），不做 lib build；
  `bun run build` 只构建 demo 静态资源。
- 只依赖第三方 npm 包与 React 生态，**不依赖任何 `@fenix/*` 业务包**。
- 多租户、鉴权、请求、路由、i18n 单例等宿主职责一律不进入本包。

## 目录约定

```
web/                      组件源码；必须在 web/ 下
  index.ts                barrel
  lib/                    cn / i18n 命名空间常量 / theme / card-renderer
  styles/theme.css        设计 token（唯一样式入口）
  i18n/locales/{en,zh}/   包内文案，命名空间 uiComponents
  ui/ config/ ai-elements/ components/ layout/
demo/                     Vite 展示页（非库产物）
```

**为什么必须在 `web/` 下**：宿主仓库的 Tailwind 约定是「应用壳 + 各包源码所在的 `web/` 目录」一起扫描
（见 `apps/web/src/index.css` 的 `@source`）。包内 `theme.css` 也用 `@source "../**/*.{ts,tsx}"` 反扫自身。
组件若放在 `web/` 之外，宿主与 demo 都不会扫描到其中的工具类，样式会被静默裁剪。

## 纯化决策（相对 apps/web 源实现）

| 位置 | 源实现 | 本包做法 |
| --- | --- | --- |
| `web/lib/cn.ts` | `@/src/lib/utils`（同文件还有 esc/formatTime/uuid 等） | 只保留 `cn`，其余工具属于宿主应用 |
| `web/lib/i18n.ts` | `@/src/i18n` 单例 + `NS.COMPONENTS` / `NS.COMMON` | 只导出 `UI_COMPONENTS_NS = "uiComponents"`，资源由宿主注册 |
| `web/lib/theme.tsx` | 源实现临时强制浅色，忽略 localStorage 与系统偏好 | 移除该 hack：初始主题取 localStorage，缺省回退 `defaultTheme`，`system` 跟随系统 |
| `web/lib/card-renderer.tsx` | `@/src/lib/card-renderer/registry` + context/emitter | 只保留注册表，去掉会话事件通道；初始注册表为空 |

`ConnectionState`、`PermissionOption` 等原先来自 `@fenix/chat-channel` 的类型，改为包内同构联合类型/字面量结构类型，
避免把业务包拖进依赖图。

## i18n

本包不自带 i18n 实例。宿主渲染这些组件前必须把包内文案注册到 `uiComponents` 命名空间：

```ts
import en from "@fenix/ui-components/i18n/locales/en/uiComponents.json";
import zh from "@fenix/ui-components/i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/lib/i18n";

i18n.addResourceBundle("en", UI_COMPONENTS_NS, en, true, true);
i18n.addResourceBundle("zh", UI_COMPONENTS_NS, zh, true, true);
```

键名沿用源仓库 `components` 命名空间的末段路径（`components.codeBlock.copy` → `codeBlock.copy`），
另合并了 `common` 的 `preview` / `small` / `medium` / `large` / `fullscreen`。
两份语言文件的键结构必须保持一致。

## 已知限制

1. **未引入 `tw-animate-css`**：源仓库虽然在其 devDependencies 里声明了该包，但没有任何 CSS 实际 `@import` 它，
   因此 `animate-in` / `animate-out` / `animate-accordion-*` 在源仓库本就是空操作。本包保持现状一致，不引入。
   demo 例外：`demo/demo.css` 为展示过渡效果单独 `@import` 了它，该依赖因此只声明在 devDependencies，不随包产物分发。
   - 影响范围：依赖这些类的过渡动画（dialog、accordion 等）在源仓库同样没有动画。
   - 移除条件：源仓库正式引入 `tw-animate-css` 并在主题入口 `@import` 之后再同步。
2. **`status-badge-active` 是未定义类**：`config/StatusBadge.tsx` 使用该类，但源仓库与本包都没有定义它，不产生样式。
   - 移除条件：宿主提供该工具类，或改为包内 token 驱动的高亮。
3. **`@plugin "@tailwindcss/typography"`**：`tool` / `reasoning` 组件使用 `prose` 系列类名，主题入口因此声明了该插件，
   消费方编译本包 CSS 时需能解析到 `@tailwindcss/typography`（已列入 dependencies）。
4. **宿主外观不随包迁移**：源 `apps/web/src/index.css` 的 base 层、sonner 定位、滚动条、`@utility tool-status-pill*`
   与 `@keyframes`（`status-active-pulse`、`shimmerSlide` 等）都属于应用壳，未进入 `theme.css`。
   - 影响范围：目前 `ui/`、`config/`、`ai-elements/` 下已核对的组件未使用这些类；后续批次若引入依赖它们的组件需重新评估。
5. **`ui/pagination.tsx` 的 `translationPrefix` 默认值为 `"runs"`**，其文案来自调用方注入的 `t`（非本包命名空间），
   本包字典不含该命名空间；消费方必须自行传入 `t`。
6. **未迁移 streamdown 表格全屏补丁**：源宿主在 `apps/web/src/main.tsx` 入口调用 `installStreamdownTablePatch()`，
   为 streamdown 全屏表格对话框补上缺失的 `data-streamdown="table-wrapper"`（缺失时全屏视图下的复制/下载按钮无响应）。
   该补丁依赖 streamdown 内部 DOM 结构，属于应用壳，未随组件进入本包。
   - 影响范围：仅 `ai-elements/message.tsx`（`MessageResponse` 渲染 streamdown）的表格全屏视图；demo 未安装该补丁，
     需要该行为的宿主必须在自己的入口安装等价补丁。
   - 移除条件：streamdown 修复全屏表格缺失 `data-streamdown="table-wrapper"` 的行为。
7. **`MessageResponse` 的 `envId` 指向宿主文件代理路由**：传入 `envId` 时相对资源路径会被改写为
   `/web/environments/<envId>/fs/<path>?preview=true`（源宿主应用约定），本包不定义该路由。
   - 影响范围：不传 `envId` 时 URL 原样透传，组件不依赖任何宿主路由；传 `envId` 的宿主需自行提供该路由。
   - 移除条件：宿主改为注入自定义 `urlTransform`，或把代理前缀提升为 prop。

## 未来接入 apps/web（本期不做）

1. 在 `apps/web/vite.config.ts` 增加 `@fenix/ui-components` → `packages/ui-components/web/index.ts` 的 alias
   （以及 `.../styles.css` → `packages/ui-components/web/styles/theme.css`）。
2. `apps/web/tsconfig.json` 的 `paths` 增加同名映射，`apps/web/src/i18n/index.ts` 注册 `uiComponents` 命名空间资源，
   并让 `NS.COMPONENTS` 使用方逐步切换到 `UI_COMPONENTS_NS`。
3. 逐组件把 `apps/web` 下的引用改为 `@fenix/ui-components/*`，确认无重复实现后删除 `apps/web` 中的旧文件
   （同一份组件不得长期双份存在）。
4. 接入后运行 `bun run build:web` 与 `bun run precheck`，重点确认 Tailwind 扫描到包内工具类且文案无缺失。

## 脚本

```bash
bun run dev        # 启动 demo（端口 5273）
bun run build      # 构建 demo 到 dist/
bun run preview    # 预览 demo 构建产物
bun run typecheck  # tsc -p tsconfig.json --noEmit
bun run test       # bun test
```
