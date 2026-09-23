import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { createContext, useContext } from "react";

import { cn } from "../lib/cn";
import "./tabs.css";

/**
 * 朝向上下文：`Tabs` 注入，`TabsList` / `TabsTrigger` 取用，值恒为**最近一层** `Tabs` 的朝向。
 *
 * 为什么需要它：水平/垂直两套尺寸必须落在 List / Trigger 自己身上，而 Radix 只把 `data-orientation`
 * 挂在 Root 与 Content（List / Trigger 上只有 `aria-orientation`，见 `@radix-ui/react-tabs` 的
 * TabsList / TabsTrigger 实现）。原实现因此从 Root 上取：`group-data-[orientation=…]/tabs:` ——
 * CSS 的 group 变体匹配的是**任意**祖先，于是「内层 Tabs 嵌在外层 Tabs 内、两者朝向不同」时，
 * 内层会连外层的另一套变体一起吃进来。
 *
 * 实测（headless Chrome 复刻 AgentFormDialog 的真实祖先链：外层 workspace Tabs 竖直、
 * 内层「能力与工具」页签水平）：内层页签条被外层的 vertical 变体撑成竖排（高度 32.7px → 94.3px，
 * 三枚页签从并排变成上下叠放），选中下划线从「页签底部的横条」变成「触发器左缘的竖条」。
 * React context 天然只取最近一层，正好补上 CSS 表达不出的这层语义；`group/tabs` 随之从根节点删除，
 * 避免这段祖先语义被再次写回来。
 */
const TabsOrientationContext = createContext<"horizontal" | "vertical">("horizontal");

/** 最近一层 `Tabs` 的朝向（无 `Tabs` 祖先时按 `horizontal`，与 Radix 的默认值一致）。 */
function useTabsOrientation() {
  return useContext(TabsOrientationContext);
}

function Tabs({ className, orientation = "horizontal", ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsOrientationContext.Provider value={orientation}>
      <TabsPrimitive.Root
        data-slot="tabs"
        data-orientation={orientation}
        orientation={orientation}
        className={cn("flex gap-2 data-[orientation=horizontal]:flex-col", className)}
        {...props}
      />
    </TabsOrientationContext.Provider>
  );
}

/** 触发器高度契约见 `tabs.css` 文件头 ②（`h-(--tabs-trigger-height)` 必须留在工具类里，供调用方 `h-6` 覆盖）。 */
const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-0.75 text-muted-foreground data-[orientation=horizontal]:h-9 data-[orientation=vertical]:h-fit data-[orientation=vertical]:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      data-orientation={useTabsOrientation()}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-orientation={useTabsOrientation()}
      className={cn(
        // 高度引用 `tabs.css` 的变量（不是就地写死值）：见该文件头 ② 的层叠说明。
        "tabs-trigger relative inline-flex h-(--tabs-trigger-height) flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none dark:text-muted-foreground dark:hover:text-foreground [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "data-[state=active]:bg-background data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground",
        // 下划线偏移写成 `-bottom-1.25`：`bottom--1.25`（双短横）是非法的负数写法，Tailwind 不为它生成
        // 任何声明，下划线会退回 flex 静态位置（居中，实测 bottom/top 均为 9.375px，横穿页签文字）。
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity data-[orientation=horizontal]:after:inset-x-0 data-[orientation=horizontal]:after:-bottom-1.25 data-[orientation=horizontal]:after:h-0.5 data-[orientation=vertical]:after:inset-y-0 data-[orientation=vertical]:after:-right-1 data-[orientation=vertical]:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  forceMount,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content> & {
  forceMount?: true;
}) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      forceMount={forceMount}
      className={cn("flex-1 outline-none", forceMount && "data-[state=inactive]:hidden", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
