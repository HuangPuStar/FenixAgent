import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@fenix/ui-components";
import { useState } from "react";

/**
 * Base UI P3 · 弹窗与浮层：AlertDialog / Dialog（含 size="xl"）/ Sheet / Popover / Tooltip / HoverCard /
 * DropdownMenu / Command（cmdk）。
 *
 * 动画依赖：Popover、Tooltip、HoverCard、DropdownMenu 与 Sheet 的进出场类来自 tw-animate-css
 * （demo.css 已 @import）。包本身不引入该依赖，宿主缺少它时组件功能完整但没有过渡动画。
 *
 * 覆盖「确认」与「危险操作」两类状态：危险操作由 AlertDialog 的 destructive 动作承担，
 * 普通确认由 Dialog / Sheet 承担。带 loading 的确认与表单弹窗自持异步流程，
 * 属于组合容器层（Base UI P2），不在本子文件。
 *
 * 已知限制：包内没有 Toast / Notification 类组件。
 * 影响范围：瞬时提示只能靠弹窗内文案与调用方回显表达，本子文件缺少自动消失的轻提示示例。
 * 移除条件：包内新增 toast 组件后，在本子文件补一个对应小节。
 */

/**
 * Command 的两处示例（内联面板与命令面板弹窗）共用同一份条目，避免两边漂移；
 * onSelect 只回写最近一次命令，用于证明回调已触发。
 */
function CommandItems({ onSelect }: { onSelect: (value: string) => void }) {
  return (
    <>
      <CommandGroup heading="Suggestions">
        <CommandItem value="calendar" onSelect={onSelect}>
          Calendar
        </CommandItem>
        <CommandItem value="search" onSelect={onSelect}>
          Search sessions
        </CommandItem>
        <CommandItem value="settings" onSelect={onSelect}>
          Settings
        </CommandItem>
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup heading="Actions">
        <CommandItem value="new" onSelect={onSelect}>
          New session
          <CommandShortcut>⌘N</CommandShortcut>
        </CommandItem>
        <CommandItem value="invite" onSelect={onSelect}>
          Invite teammate
          <CommandShortcut>⌘I</CommandShortcut>
        </CommandItem>
      </CommandGroup>
    </>
  );
}

/** 弹窗与浮层示例组。 */
export function FeedbackOverlayExamples() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [density, setDensity] = useState("comfortable");
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  return (
    <>
      <p className="mt-3 text-text-muted text-[12px]">
        本分区的浮层组件依赖 tw-animate-css 提供 animate-in / animate-out 等过渡类（demo.css 已引入）；
        宿主未安装该依赖时浮层仍可用，只是没有进出场动画。
      </p>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          AlertDialog
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
            危险操作的二次确认：取消按钮默认聚焦，动作按钮使用 destructive 变体。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline">Delete workspace</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete workspace?</AlertDialogTitle>
                  <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => setLastEvent("Delete confirmed (simulated)")}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          Dialog（默认 / size=&quot;xl&quot;）
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
            常规弹窗与 960px 的超大弹窗是同一实现的两种尺寸：size=&quot;xl&quot; 只放开宽度、圆角与内边距，
            其余开关（showOverlay / disableOverlayClose / disableEscapeClose）两者一致。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Archive session</DialogTitle>
                  <DialogDescription>Archived sessions stay readable but reject new prompts.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost">Cancel</Button>
                  </DialogClose>
                  <Button onClick={() => setLastEvent("Session archived (simulated)")}>Archive</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Open XL dialog</Button>
              </DialogTrigger>
              <DialogContent size="xl">
                <DialogHeader className="border-b p-6">
                  <DialogTitle>Agent trace</DialogTitle>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto p-6 text-sm text-muted-foreground">
                  size=&quot;xl&quot; 的弹窗宽 960px，主体自行滚动，适合长内容与图文混排；下面的页脚保持固定高度。
                </div>
                <div className="flex justify-end gap-2 border-t p-4">
                  <DialogClose asChild>
                    <Button variant="outline">Close</Button>
                  </DialogClose>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          Sheet
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
            侧滑抽屉：side 支持 right / left / top / bottom，进出场动画依赖 tw-animate-css（见浮层分区说明）。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Open sheet</Button>
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>Filters</SheetTitle>
                  <SheetDescription>Adjust the filters, then apply them to the list.</SheetDescription>
                </SheetHeader>
                <div className="flex flex-1 flex-col gap-4 px-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="demo-sheet-query">Keyword</Label>
                    <Input id="demo-sheet-query" placeholder="Search sessions" />
                  </div>
                </div>
                <SheetFooter>
                  <Button onClick={() => setLastEvent("Filters applied (simulated)")}>Apply</Button>
                  <SheetClose asChild>
                    <Button variant="outline">Close</Button>
                  </SheetClose>
                </SheetFooter>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          Popover
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
            点击触发，内容通过 Portal 渲染到 body，宽度与内边距由包内样式决定。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">Rename session</Button>
              </PopoverTrigger>
              <PopoverContent align="start">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="demo-popover-name">Session name</Label>
                  <Input id="demo-popover-name" defaultValue="Nightly triage" />
                  <Button size="sm" onClick={() => setLastAction("Popover saved")}>
                    Save
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          Tooltip
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
            纯提示不接收交互，side 决定浮层方位；TooltipProvider 可统一设置 delayDuration（默认 400ms）。
          </p>
          <TooltipProvider delayDuration={200}>
            <div className="flex flex-wrap items-center gap-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost">Top</Button>
                </TooltipTrigger>
                <TooltipContent side="top">Appears above the trigger</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost">Right</Button>
                </TooltipTrigger>
                <TooltipContent side="right">Appears to the right</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost">Bottom</Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Appears below the trigger</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          HoverCard
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
            悬停展开、可容纳富内容；鼠标移出后延迟关闭，适合预览类信息。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <HoverCard openDelay={200} closeDelay={100}>
              <HoverCardTrigger asChild>
                <Button variant="link">@fenix/ui-components</Button>
              </HoverCardTrigger>
              <HoverCardContent align="start" className="w-72">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">UI components package</span>
                  <span className="text-xs text-muted-foreground">
                    Radix 基元 + Tailwind token，源码位于 web/ 下，按需深链导入。
                  </span>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>
        </div>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          DropdownMenu（分组 / 复选 / 单选 / 子菜单）
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
            列表项分四类：普通项、CheckboxItem、RadioGroup 项与 Sub 子菜单；destructive 项用于不可逆操作。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Open menu</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>My account</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => setLastAction("Profile")}>
                    Profile
                    <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setLastAction("Billing")}>Billing</DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={showGrid}
                  onCheckedChange={(checked) => setShowGrid(checked === true)}
                >
                  Show grid
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={density} onValueChange={setDensity}>
                  <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Invite users</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onSelect={() => setLastAction("Invite by email")}>Email</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setLastAction("Invite by link")}>Copy link</DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setLastAction("Delete draft")}>
                  Delete draft
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <p className="mt-3 text-text-muted text-[12px]">
            showGrid = {String(showGrid)}，density = {density}
            {lastAction ? `，最近一次动作：${lastAction}` : null}
          </p>
        </div>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          Command（cmdk）
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
            内联面板：输入即过滤，CommandEmpty 在无匹配时接管；下面同一份条目也用于 CommandDialog 弹窗。
          </p>
          <Command className="rounded-lg border shadow-sm">
            <CommandInput placeholder="Type a command or search..." />
            <CommandList className="max-h-[240px]">
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandItems onSelect={setLastAction} />
            </CommandList>
          </Command>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => setPaletteOpen(true)}>
              Open command palette
            </Button>
          </div>

          <CommandDialog
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            title="Command palette"
            description="Search for a command to run."
          >
            <CommandInput placeholder="Type a command or search..." />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandItems
                onSelect={(value) => {
                  setLastAction(value);
                  setPaletteOpen(false);
                }}
              />
            </CommandList>
          </CommandDialog>
        </div>
      </div>

      {lastEvent ? <p className="mt-3 text-text-muted text-[12px]">Last callback: {lastEvent}</p> : null}
    </>
  );
}
