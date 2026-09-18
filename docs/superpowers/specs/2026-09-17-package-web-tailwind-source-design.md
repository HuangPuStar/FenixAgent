# Package Web Tailwind 扫描修复设计

## 背景

CE/EE 物理迁移把多个前端组件从 `apps/web` 移入 `packages/**/web`。当前 Tailwind v4 入口 `apps/web/src/index.css` 只通过 `@source "../**/*.{ts,tsx}"` 扫描 `apps/web`，因此包内组件使用但应用目录未重复出现的工具类不会进入生产 CSS。

已确认的用户可见回归是 `/ctrl/agent/home` 选择模板后，“创建 Agent”按钮默认态丢失蓝色渐变，仅 hover 时因公共按钮样式而显示蓝色。迁移前后组件 class 列表没有行为差异，断裂点是 Tailwind source 范围。

## 目标与范围

- Tailwind 同时扫描 `apps/web/**` 与 `packages/**/web/**/*.{ts,tsx}`。
- 恢复所有已迁移 package Web 组件的静态 Tailwind 类，不逐组件复制或手写补丁。
- 保持“创建 Agent”按钮迁移前的默认蓝色渐变、白色文字及 hover 渐变。
- 不修改组件结构、交互、接口、后端或数据库。
- 不扫描 `packages` 下的服务端源码；测试文件位于 Web 边界内时允许进入扫描范围，以换取单一稳定 glob，后续如产物体积出现可测量增长再单独收窄。

## 方案

在 `apps/web/src/index.css` 增加：

```css
@source "../../../packages/**/web/**/*.{ts,tsx}";
```

该路径相对 `apps/web/src/index.css` 解析，覆盖 `packages/agent-runtime/web`、`packages/chat-channel/web` 及所有 `packages/resources/*/web`，不依赖具体 package 清单。

不采用以下方案：

- 为单个按钮补手写 CSS：只能掩盖一个症状，其他迁移组件仍可能缺失样式。
- 把组件移回 `apps/web`：破坏已完成的 package 领域边界。

## 验证

1. 先增加构建合同测试，证明当前 CSS source 未覆盖 package Web，再补 source 配置使测试转绿。
2. 运行相关前端测试、Biome、Web typecheck 与 `bun run build:web`。
3. 检查生产 CSS 包含按钮独有的渐变起止色工具类。
4. 在 `/ctrl/agent/home` 选择模板，浏览器检查“创建 Agent”按钮：
   - 默认态为蓝色渐变、白字；
   - hover 后仍为更深蓝色渐变；
   - disabled、提交行为和页面布局不变。

## 回滚

回滚单行 `@source` 和对应合同测试即可恢复原扫描范围；不涉及数据或协议变更。
