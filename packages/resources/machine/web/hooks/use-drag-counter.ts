/**
 * 拖拽进入/离开计数器（`dragenter`/`dragleave` 成对计数的唯一实现）。
 *
 * 为什么需要计数：拖拽文件经过绑定区域的**子元素**时也会冒泡出 `dragenter`/`dragleave`
 * （两者一一对应但会任意嵌套），直接按单个事件置位会让遮罩在子元素之间闪断。计数器的做法是
 * 「进入 +1、离开 -1，归零才算真的离开区域」。归零用 `<= 0` 而不是 `=== 0`：事件不成对时
 * 计数可能漂到负数，夹回 0 才能让下一次拖拽仍被识别。
 *
 * 与 `drop` 的分工：归零动作由调用方在 `onDrop` 里调用 `resetDragCounter()`——放下之后的落点解析
 * 与上传不属于本 hook。
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
