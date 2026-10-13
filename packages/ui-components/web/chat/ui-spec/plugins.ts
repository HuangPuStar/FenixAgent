/**
 * `ui-spec` 的 streamdown 注册常量（计划 §1.1 冻结接口）。
 *
 * 为什么是模块级常量而不是宿主 prop：开放成 prop 会让每个调用点各持一份配置（撤销、比对、测试都要
 * 逐点改），而 renderer 本身与宿主无关；宿主侧只需要 `plugins={UI_SPEC_PLUGINS}` 一处接线。
 *
 * 依赖边界（§5.2 懒加载边界）：这里**只静态引 `UISpecBlock`**。streamdown 的容器 / 标题 / 骨架由
 * `UISpecBlock` 内部动态加载，故本文件不把 streamdown 拉进首屏静态图，`message.tsx` 的既有
 * `lazy(() => import("streamdown"))` 边界得以保留。
 */

import type { PluginConfig } from "streamdown";
import { UI_SPEC_LANGUAGE } from "./spec";
import { UISpecBlock } from "./UISpecBlock";

/** 围栏语言标识：正文里写成 ```ui-spec。定义在 `spec.ts`（解析侧与注册侧共用），此处再导出保持既有引用路径。 */
export { UI_SPEC_LANGUAGE };

/** streamdown 插件配置：把 `ui-spec` 围栏交给自有渲染器；撤销本常量即恢复普通代码块。 */
export const UI_SPEC_PLUGINS: PluginConfig = {
  renderers: [{ language: UI_SPEC_LANGUAGE, component: UISpecBlock }],
};
