import { useCallback, useEffect, useRef, useState } from "react";

interface RovingListNavigationOptions {
  itemKeys: string[];
  onSelect: (key: string) => void;
}

/**
 * 为焦点位于列表外部的 command panel 提供 roving active item。
 * 适用于 textarea 驱动的 slash menu：不抢 DOM focus，但保持高亮、键盘导航和滚动位置同步。
 */
export function useRovingListNavigation({ itemKeys, onSelect }: RovingListNavigationOptions) {
  const [activeKey, setActiveKey] = useState<string | null>(itemKeys[0] ?? null);
  const itemRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    setActiveKey(itemKeys[0] ?? null);
  }, [itemKeys]);

  useEffect(() => {
    if (!activeKey) return;
    itemRefs.current.get(activeKey)?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const registerItem = useCallback(
    (key: string) => (element: HTMLElement | null) => {
      if (element) itemRefs.current.set(key, element);
      else itemRefs.current.delete(key);
    },
    [],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (itemKeys.length === 0) return;
      const currentIndex = activeKey ? itemKeys.indexOf(activeKey) : -1;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setActiveKey(itemKeys[(currentIndex + 1 + itemKeys.length) % itemKeys.length] ?? null);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActiveKey(itemKeys[(currentIndex - 1 + itemKeys.length) % itemKeys.length] ?? null);
      } else if (event.key === "Enter" && !event.shiftKey && activeKey) {
        event.preventDefault();
        event.stopPropagation();
        onSelect(activeKey);
      }
    },
    [activeKey, itemKeys, onSelect],
  );

  return { activeKey, setActiveKey, registerItem, handleKeyDown };
}
