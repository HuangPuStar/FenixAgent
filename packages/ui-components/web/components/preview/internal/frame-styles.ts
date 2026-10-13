/**
 * 预览插件自建 DOM 的外壳样式（内部模块，不在公共出口内）。
 *
 * html / pdf 两个插件各自 `document.createElement` 出同一套外壳——一个撑满 viewport 的纵向容器
 * 加一个铺满其下的沙箱 iframe——这两段 `cssText` 原本在两侧逐字重复。
 *
 * 为什么是内联样式字符串而不是 Tailwind 工具类：这两处 DOM 由插件在**非 React 上下文**里直接创建，
 * 类名既没有宿主 Tailwind 的 `@source` 覆盖（扫的是源码里的字面量，生成不到这里），iframe 内部也不
 * 接受外部样式表；源实现即以内联 cssText 表达，逐字保留。
 *
 * 为什么能共用：两处外壳的几何与配色诉求一致（撑满可用区、白底、无边框），差异只在容器内多不多一条
 * 标签栏——那由 html 插件自己再插一层，不影响这两条声明。
 */

/** 外壳容器：撑满 viewport，纵向排布（标签栏 + iframe 依次成行）。 */
export const PREVIEW_FRAME_CONTAINER_STYLE = "width:100%;height:100%;display:flex;flex-direction:column;";

/** 沙箱 iframe：占满容器剩余高度，白底、无边框（与预览内容的白色画布连成一片）。 */
export const PREVIEW_FRAME_IFRAME_STYLE = "flex:1;width:100%;border:none;background:#fff;";
