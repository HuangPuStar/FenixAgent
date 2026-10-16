/**
 * 会话行的拖拽适配层：dnd-kit 的传感器与事件翻译（`useSpaceSessionDrag`）与可拖行外壳
 * （`DraggableSessionRow`）。
 *
 * 本层只做「交互状态 → 会话 id + 落点 id」的翻译，归属决策留给纯函数 `resolveDropTarget`
 * （`lib/space-drop-target.ts`），写入留给侧栏——三者各自可单独替换与测试。
 *
 * 三个取舍：
 * 1. **只用 PointerSensor，且设 5px 激活阈值**：会话行既是点击目标（切换会话）又是拖拽源。
 *    没有阈值时按下即进入拖拽，点击就再也选不中会话；阈值太大则「拖了一点却没反应」。
 *    5px 落在手抖与有意的拖动之间，正好覆盖「按下时的轻微位移」。
 * 2. **不做键盘拖拽**：dnd-kit 的键盘传感器要求拖拽源可聚焦并被读屏正确播报，而会话行是复合控件
 *    （标题按钮 + 动作按钮），把 `role="button"` 挂到整行上会破坏它自身的语义。原先的等效路径是
 *    行内「移动到…」菜单，2026-10-16 按用户要求删除（决策与影响见 `docs/design/2026-10-15-chat-space-design.md`
 *    §6.4）——**本层因此成为归属写入的唯一路径，键盘用户暂时无法移动会话归属**。
 * 3. **不设 `touch-action: none`**：移动端抽屉里的列表必须能滚动，触屏拖拽本就不是主路径（见上一条）。
 *    代价是触屏上的拖动会被浏览器判为滚动、以 `pointercancel` 中止——这正是预期行为，比「列表滚不动」划算；
 *    菜单删除后同一代价还意味着**移动端抽屉里暂时无法移动会话归属**（恢复条件见 §6.4）。
 *
 * 落点判定用 `pointerWithin`：用户松手时看到的是「指针压在哪一组上」，用矩形相交判定会在分组
 * 边界附近选到视觉上并未悬停的邻居。本层不做排序（不引 `@dnd-kit/sortable`），
 * 组内顺序由 `groupBySpace` 的「最近优先」决定。
 */

import {
  type DragEndEvent,
  PointerSensor,
  pointerWithin,
  type SensorDescriptor,
  type SensorOptions,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useCallback } from "react";
import { cn } from "../../../lib/cn";
import type { SessionSummary } from "../../types";
import { SessionRow, type SessionRowActions, type SessionRowState } from "./session-row";

/** 拖动激活阈值（像素）：小于它是点击，大于它才是拖动。 */
const DRAG_ACTIVATION_DISTANCE = 5;

/** 落点判定交给 `DndContext`；见文件头的取舍说明。 */
export const SPACE_DROP_COLLISION_DETECTION = pointerWithin;

/** `useSpaceSessionDrag` 的返回面（逐项交给 `DndContext`，不在本层拼 JSX）。 */
export interface SpaceSessionDrag {
  sensors: SensorDescriptor<SensorOptions>[];
  /** 拖动结束：把「会话 id + 落点 id」交给调用方解析（落点为空即松手在列表之外，不改归属） */
  onDragEnd: (event: DragEndEvent) => void;
}

/**
 * space 分组树的拖拽装配。
 *
 * @param onDropSession 拖动结束时的落点回调；`overId` 是放置目标 id（`toSpaceDropId` 的产物）
 */
export function useSpaceSessionDrag(onDropSession: (sessionId: string, overId: string) => void): SpaceSessionDrag {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }),
  );
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      onDropSession(String(active.id), String(over.id));
    },
    [onDropSession],
  );
  return { sensors, onDragEnd };
}

export interface DraggableSessionRowProps {
  session: SessionSummary;
  state: SessionRowState;
  actions: SessionRowActions;
}

/**
 * 可拖动的会话行外壳。
 *
 * 只把 `ref` 与指针监听挂在**外层容器**上，行本体（`SessionRow`）保持纯展示：拖拽是列表编排能力，
 * 不属于行的语义。整行都是拖拽源（含动作按钮），阈值保证按钮的点击不被吞掉。
 *
 * 不铺 dnd-kit 的 `attributes`（`role="button"` / `aria-roledescription="draggable"`）：本层没有
 * 键盘传感器，读屏用户用不到这些播报，而把整行标成 button 会与行内的真按钮冲突。
 * `data-draggable-session` 因此成为「拖拽层已装配」的唯一 DOM 信号，供测试与自动化断言。
 */
export function DraggableSessionRow({ session, state, actions }: DraggableSessionRowProps) {
  const { setNodeRef, listeners, transform, isDragging } = useDraggable({ id: session.sessionId });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      data-draggable-session={session.sessionId}
      // 拖动中的行随指针平移；`transform` 只在拖动期间非空，静止时这里不产生任何内联样式
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(isDragging && "relative z-10 opacity-50")}
    >
      <SessionRow session={session} state={state} actions={actions} />
    </div>
  );
}
