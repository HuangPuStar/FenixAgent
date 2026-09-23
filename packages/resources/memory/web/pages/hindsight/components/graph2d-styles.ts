/**
 * `Graph2d` 的 cytoscape 外观：主题化样式表 + fcose 布局参数（并注册 fcose 扩展）。
 *
 * 从组件里分出来的理由：这是一份**纯描述数据**（无组件状态、无 DOM、无事件），
 * 而组件文件要留给「容器挂载 + cy 实例生命周期 + 交互」；两者混在一起时改配色要翻过整套初始化流程。
 * 样式与布局是这套 cytoscape 图谱独有的，不与自绘 canvas 的 `Constellation` 共享（刻意分叉，§4.8）。
 *
 * 注意 `cytoscape.use(fcose)` 是模块级副作用：布局名 `"fcose"` 只在注册后可解析，
 * 因此引用布局参数的调用方必须与这里同一条导入链。
 */

import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";

// Register the fcose extension
cytoscape.use(fcose);

/**
 * 主题化样式表：文字色、文字底、边框与边的透明度都在这里按亮暗分叉。
 * `style` 的类型定义不完整（`data(...)` 与图层属性超出声明），整体断言与迁移前一致。
 */
export function buildGraph2dStylesheet(showLabels: boolean, isDarkMode: boolean): cytoscape.StylesheetJson {
  // Theme-aware colors
  const textColor = isDarkMode ? "#ffffff" : "#1f2937";
  const textBgColor = isDarkMode ? "rgba(0,0,0,0.8)" : "rgba(255,255,255,0.9)";

  return [
    {
      selector: "node",
      style: {
        "background-color": "data(color)",
        width: "data(size)",
        height: "data(size)",
        label: showLabels ? "data(label)" : "",
        color: textColor,
        "text-valign": "bottom",
        "text-halign": "center",
        "font-size": "8px",
        "font-weight": 500,
        "text-margin-y": 3,
        "text-wrap": "wrap",
        "text-max-width": "80px",
        "text-background-color": textBgColor,
        "text-background-opacity": 0.9,
        "text-background-padding": "2px",
        "text-background-shape": "roundrectangle",
        "border-width": 1,
        "border-color": isDarkMode ? "#ffffff20" : "#00000020",
        "border-opacity": 0.3,
      },
    },
    {
      selector: "node:selected",
      style: {
        "border-width": 3,
        "border-color": "#0074d9",
        "border-opacity": 1,
      },
    },
    {
      selector: "edge",
      style: {
        width: "data(width)",
        "line-color": "data(color)",
        "target-arrow-color": "data(color)",
        "target-arrow-shape": "triangle",
        "target-arrow-size": 6,
        "curve-style": "bezier",
        opacity: isDarkMode ? 0.6 : 0.7,
      },
    },
    // Focus mode styles
    {
      selector: ".dimmed",
      style: {
        opacity: 0.2,
      },
    },
    {
      selector: ".focused",
      style: {
        "border-width": 4,
        "border-color": "#ff6b35",
        "border-opacity": 1,
        "z-index": 999,
      },
    },
    {
      selector: ".connected",
      style: {
        "border-width": 2,
        "border-color": "#0074d9",
        "border-opacity": 0.8,
        opacity: 1,
      },
    },
    {
      selector: "edge.connection",
      style: {
        width: 2,
        opacity: 1,
        "z-index": 100,
      },
    },
    {
      selector: "edge.connection:hover",
      style: {
        width: 3,
        opacity: 1,
        "z-index": 200,
      },
    },
    // Disable edge selection styling
    {
      selector: "edge:selected",
      style: {
        "overlay-opacity": 0,
        "overlay-color": "transparent",
        "overlay-padding": 0,
      },
    },
  ] as unknown as cytoscape.StylesheetJson;
}

/**
 * fcose 布局参数：值照抄迁移前（分离度 / 迭代次数 / 重力是调出来的手感，不要顺手改数）。
 * `idealEdgeLength` 与 `edgeElasticity` 在 fcose 里就是函数型参数，故这里也是函数。
 * fcose 的参数超出 cytoscape 的 `BaseLayoutOptions` 声明，调用方需整体断言（同迁移前）。
 */
export const FOCSE_LAYOUT_OPTIONS: Record<string, unknown> = {
  name: "fcose",
  quality: "default",
  randomize: false,
  animate: true,
  animationDuration: 1500,
  // Separation settings - increase to spread nodes more
  nodeSeparation: 200,
  idealEdgeLength: () => 250,
  edgeElasticity: () => 0.05,
  nestingFactor: 0.05,
  gravity: 0.05, // Reduced gravity spreads nodes more
  numIter: 2500,
  // Overlap prevention
  nodeOverlap: 30,
  avoidOverlap: true,
  nodeDimensionsIncludeLabels: true,
  // Layout bounds - reduce padding to use more space
  padding: 20,
  boundingBox: undefined,
  // Tiling - increase spacing between disconnected components
  tile: true,
  tilingPaddingVertical: 30,
  tilingPaddingHorizontal: 30,
  // Force more spread
  uniformNodeDimensions: false,
  packComponents: false, // Don't pack components tightly
};
