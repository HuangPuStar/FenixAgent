import { type RefObject, useEffect, useState } from "react";

/**
 * 读出元素高度并跟随其变化（`ResizeObserver`）—— 可视化外壳与实体图谱此前各写一份逐字相同的 effect。
 *
 * 为什么收在一处：`MemoryVisualizationShell`（把高度回给子节点）与 `EntitiesView`（把高度交给
 * `Constellation`）要的是**同一个**尺寸口径——容器高度取整、初始与后续变化都要同步、卸载时断开观察。
 * 两份逐字复制时，任何一侧改了取整方式或漏掉 `disconnect`，同页两个画布的尺寸就会各错各的。
 *
 * 初值为什么是 1 而不是 0：高度会直接进 canvas 的尺寸计算，0 在除算里会退化成 `NaN`；迁移前两份
 * 实现的初值都是 1，这里照抄。
 */
export function useElementHeight<T extends HTMLElement>(ref: RefObject<T | null>, initialHeight = 1): number {
  const [height, setHeight] = useState(initialHeight);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const updateHeight = () => {
      const nextHeight = Math.floor(element.getBoundingClientRect().height);
      if (nextHeight > 0) setHeight(nextHeight);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return height;
}
