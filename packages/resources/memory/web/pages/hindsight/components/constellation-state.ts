/**
 * `Constellation` 的逐帧交互状态：字段口径与初值。
 *
 * 为什么是 `ref` 而不是 `useState`：平移、缩放与鼠标位置每帧都在变，进 state 等于每帧重渲染整棵树；
 * 读它的只有 canvas 绘制层与 tooltip 层，组件渲染本身不依赖这些值。
 * 为什么单开一个模块：三方要共用同一份字段口径——组件创建、绘制层读写、tooltip 层读写。
 * 初值照抄迁移前（`zoom` 起步 0.5、`mouseX/mouseY` 为 -1 表示「不在画布内」、
 * `prevHoverIndex` 为 -2 表示「还没悬停过任何节点」）。
 */

export interface ConstellationViewState {
  panX: number;
  panY: number;
  zoom: number;
  targetPanX: number;
  targetPanY: number;
  targetZoom: number;
  mouseX: number;
  mouseY: number;
  isDragging: boolean;
  dragStartX: number;
  dragStartY: number;
  panStartX: number;
  panStartY: number;
  hoverIndex: number;
  /** track changes to avoid DOM thrashing */
  prevHoverIndex: number;
  W: number;
  H: number;
  dpr: number;
}

export function createConstellationViewState(): ConstellationViewState {
  return {
    panX: 0,
    panY: 0,
    zoom: 0.5,
    targetPanX: 0,
    targetPanY: 0,
    targetZoom: 0.5,
    mouseX: -1,
    mouseY: -1,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    panStartX: 0,
    panStartY: 0,
    hoverIndex: -1,
    prevHoverIndex: -2, // track changes to avoid DOM thrashing
    W: 0,
    H: 0,
    dpr: 1,
  };
}
