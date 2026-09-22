/**
 * 拖拽进入/离开计数器（`dragenter`/`dragleave` 成对计数的唯一实现）。
 *
 * 为什么需要计数：拖拽文件经过绑定区域的**子元素**时也会冒泡出 `dragenter`/`dragleave`
 * （两者一一对应但会任意嵌套），直接按单个事件置位会让遮罩在子元素之间闪断。计数器的做法是
 * 「进入 +1、离开 -1，归零才算真的离开区域」。
 *
 * 2026-09-22 前端去重：宿主此前有两份逐字相同的实现——`components/agent-panel/FileTreeTab.tsx`
 * （文件树拖拽上传）与 `shell/ArtifactsPanel.tsx`（整个产物面板拖拽上传）。两处只有归零判据不同：
 * 文件树用 `=== 0`，产物面板用 `<= 0` 并把计数夹回 0。**这里统一取后者**——`=== 0` 在事件不成对时
 * （先收到多于 `dragenter` 的 `dragleave`）会让计数漂到负数，此后每次进入都差一格，遮罩再也不出现；
 * 夹回 0 让下一次拖拽仍能正常识别，对成对事件的行为与 `=== 0` 完全一致。
 *
 * 与 `drop` 的分工：归零动作由调用方在 `onDrop` 里调用 `resetDragCounter()`——放下之后的业务处理
 * （上传落点、切换到文件 tab 等）各调用点不同，不属于本 hook。两处调用点此前都没有监听 `dragend`，
 * 因此这里也不注册该监听（不引入行为变更）。
 */
import { type DragEvent, useCallback, useRef, useState } from "react";

export interface DragCounterHandlers {
  /** 拖拽内容位于绑定区域内（含其子元素）时为 `true`；离开区域后回到 `false`。 */
  isDragging: boolean;
  handleDragEnter: (event: DragEvent) => void;
  handleDragOver: (event: DragEvent) => void;
  handleDragLeave: (event: DragEvent) => void;
  /** 拖拽结束归零：由调用方在 `onDrop` 里调用，计数与状态一起复位。 */
  resetDragCounter: () => void;
}

export function useDragCounter(): DragCounterHandlers {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  // `preventDefault` 是「允许在该区域放下」的前置条件（否则浏览器按默认行为处理，即打开文件）；
  // `dropEffect = "copy"` 让光标显示为复制。两个调用点的取值一致，故收进 hook。
  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDragEnter = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragCounterRef.current++;
    // 只在 0 → 1 时置位：嵌套子元素的 `dragenter` 不再多触发一次渲染。
    if (dragCounterRef.current === 1) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const resetDragCounter = useCallback(() => {
    dragCounterRef.current = 0;
    setIsDragging(false);
  }, []);

  return { isDragging, handleDragEnter, handleDragOver, handleDragLeave, resetDragCounter };
}
