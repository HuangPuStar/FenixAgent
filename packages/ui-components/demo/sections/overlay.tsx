import {
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
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@fenix/ui-components";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * 浮层分区：Popover / Tooltip / HoverCard / DropdownMenu / Command（cmdk）/ Resizable / Tabs。
 *
 * 动画依赖：Popover、Tooltip、HoverCard、DropdownMenu 与 Tabs 的进出场类来自 tw-animate-css
 * （demo.css 已 @import）。包本身不引入该依赖，宿主缺少它时组件功能完整但没有过渡动画。
 *
 * Tabs 与 Resizable 不是浮层：本分区按 demo 的划分收纳「切换容器」与「可拖拽布局」，
 * Tabs 用 line 变体，与 composite 分区展示的默认实心变体互为补充。
 *
 * 导出名被 demo/App.tsx 引用，新增示例时保持导出名与签名不变。
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

export function OverlaySection() {
  const { t } = useTranslation(DEMO_NS);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [density, setDensity] = useState("comfortable");
  const [lastAction, setLastAction] = useState<string | null>(null);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.overlay")}</h1>

      <p className="demo-hint">
        本分区的浮层组件依赖 tw-animate-css 提供 animate-in / animate-out 等过渡类（demo.css 已引入）；
        宿主未安装该依赖时浮层仍可用，只是没有进出场动画。
      </p>

      <div className="demo-example">
        <h2 className="demo-example-title">Popover</h2>
        <div className="demo-field">
          <p className="demo-hint">点击触发，内容通过 Portal 渲染到 body，宽度与内边距由包内样式决定。</p>
          <div className="demo-row">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">Rename session</Button>
              </PopoverTrigger>
              <PopoverContent align="start">
                <div className="demo-field">
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

      <div className="demo-example">
        <h2 className="demo-example-title">Tooltip</h2>
        <div className="demo-field">
          <p className="demo-hint">
            纯提示不接收交互，side 决定浮层方位；TooltipProvider 可统一设置 delayDuration（默认 400ms）。
          </p>
          <TooltipProvider delayDuration={200}>
            <div className="demo-row">
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

      <div className="demo-example">
        <h2 className="demo-example-title">HoverCard</h2>
        <div className="demo-field">
          <p className="demo-hint">悬停展开、可容纳富内容；鼠标移出后延迟关闭，适合预览类信息。</p>
          <div className="demo-row">
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

      <div className="demo-example">
        <h2 className="demo-example-title">DropdownMenu（分组 / 复选 / 单选 / 子菜单）</h2>
        <div className="demo-field">
          <p className="demo-hint">
            列表项分四类：普通项、CheckboxItem、RadioGroup 项与 Sub 子菜单；destructive 项用于不可逆操作。
          </p>
          <div className="demo-row">
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
          <p className="demo-hint">
            showGrid = {String(showGrid)}，density = {density}
            {lastAction ? `，最近一次动作：${lastAction}` : null}
          </p>
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">Command（cmdk）</h2>
        <div className="demo-field">
          <p className="demo-hint">
            内联面板：输入即过滤，CommandEmpty 在无匹配时接管；下面同一份条目也用于 CommandDialog 弹窗。
          </p>
          <Command className="rounded-lg border shadow-sm">
            <CommandInput placeholder="Type a command or search..." />
            <CommandList className="max-h-[240px]">
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandItems onSelect={setLastAction} />
            </CommandList>
          </Command>

          <div className="demo-row">
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

      <div className="demo-example">
        <h2 className="demo-example-title">Resizable</h2>
        <div className="demo-field">
          <p className="demo-hint">
            面板尺寸由 react-resizable-panels 维护，拖拽中间手柄调整比例；withHandle 只是手柄的外观开关。
          </p>
          <ResizablePanelGroup orientation="horizontal" className="h-36 rounded-lg border">
            <ResizablePanel defaultSize="30%">
              <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">Sidebar</div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="70%">
              <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">Content</div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">Tabs</h2>
        <div className="demo-field">
          <p className="demo-hint">line 变体：面板切换是纯客户端行为，不产生浮层；内容面板可放任意组合内容。</p>
          <Tabs defaultValue="preview">
            <TabsList variant="line">
              <TabsTrigger value="preview">Preview</TabsTrigger>
              <TabsTrigger value="code">Code</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
            </TabsList>
            <TabsContent value="preview" className="text-sm text-muted-foreground">
              预览面板与触发项一一对应，未激活的面板不渲染。
            </TabsContent>
            <TabsContent value="code" className="text-sm text-muted-foreground">
              TabsList 的 variant 支持 default 与 line，纵向布局用 orientation="vertical"。
            </TabsContent>
            <TabsContent value="logs" className="text-sm text-muted-foreground">
              面板内容按需挂载，适合承载较重的视图。
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </section>
  );
}
