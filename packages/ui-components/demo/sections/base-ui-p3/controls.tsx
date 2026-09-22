import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
  Label,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  ScrollArea,
  ScrollBar,
  Separator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@fenix/ui-components";

import { ComponentBlock, Example } from "./shared";

/**
 * Base UI P3 · 交互控件：Button / ButtonGroup / Badge / Card / Input / Textarea / Label / InputGroup /
 * Separator / ScrollArea / Accordion / Collapsible / Resizable / Tabs。
 *
 * 布局仿 antd 官网：每个组件一个小节（标题 + 一句话说明），小节内并列 2~3 个示例
 * （h3 标题 + 说明 + 并排演示区）。每个组件的示例集合至少包含一个边界示例
 * （disabled / 空态 / 无关联 / 内容不溢出 / 全收起），并在说明里点明边界含义。
 *
 * Resizable 与 Tabs 既不是浮层也不是表单控件，按「可拖拽布局」与「切换容器」的性质归入本文件；
 * 与浮层子文件分开放，是为了避免读者把纯客户端的面板切换误当成浮层行为。
 *
 * 动画依赖：Tabs 的进出场类来自 tw-animate-css（demo.css 已 @import）。包本身不引入该依赖，
 * 宿主缺少它时组件功能完整但没有过渡动画。
 */

/** ScrollArea 的演示数据；用稳定字符串而非下标作 key，避免依赖数组顺序。 */
const SCROLL_ITEMS = [
  "Alpha",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliett",
  "Kilo",
  "Lima",
];

/** 横向滚动的方块标签，长度固定以保证演示区宽度可预期。 */
const SCROLL_TILES = ["01", "02", "03", "04", "05", "06", "07", "08"];

/** 交互控件示例组。 */
export function ControlsExamples() {
  return (
    <>
      <ComponentBlock name="Button" description="按钮；默认 variant=default、size=default，尺寸与语义变体互相独立。">
        <Example title="Variants" description="六种语义变体；link 变体无背景，用于低权重的跳转。">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
        </Example>
        <Example title="Sizes" description="xs / sm / default / lg 与方形 icon 尺寸，icon 尺寸需要自带无障碍名称。">
          <Button size="xs">Extra small</Button>
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="Add item">
            +
          </Button>
        </Example>
        <Example
          title="Disabled"
          description="边界：disabled 由原生属性驱动，禁用后不响应指针事件，也不进入键盘 tab 序列。"
        >
          <Button disabled>Default</Button>
          <Button variant="outline" disabled>
            Outline
          </Button>
          <Button variant="destructive" disabled>
            Destructive
          </Button>
        </Example>
      </ComponentBlock>

      <ComponentBlock
        name="ButtonGroup"
        description="把多个按钮粘成一组：组内相邻边框与圆角自动合并，组内元素共用焦点层级。"
      >
        <Example title="Horizontal" description="默认横向排列，适合分段操作；也可插入文本与分隔线。">
          <ButtonGroup>
            <Button variant="outline">Copy</Button>
            <Button variant="outline">Paste</Button>
            <Button variant="outline">Duplicate</Button>
          </ButtonGroup>
          <ButtonGroup>
            <ButtonGroupText>Zoom</ButtonGroupText>
            <ButtonGroupSeparator />
            <Button variant="outline">-</Button>
            <Button variant="outline">+</Button>
          </ButtonGroup>
        </Example>
        <Example title="Vertical / disabled" description="边界：纵向组中单个按钮禁用只影响自身，同组其它按钮仍可用。">
          <ButtonGroup orientation="vertical">
            <Button variant="outline">Top</Button>
            <Button variant="outline" disabled>
              Middle (disabled)
            </Button>
            <Button variant="outline">Bottom</Button>
          </ButtonGroup>
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Badge" description="状态标签；默认 variant=default，尺寸由内容撑开。">
        <Example
          title="Variants"
          description="default / secondary / outline / destructive / ghost，语义与 Button 保持一致。"
        >
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="ghost">Ghost</Badge>
        </Example>
        <Example
          title="Empty content"
          description="边界：不传 children 时标签只剩内边距，可用于占位；title 提供文字说明。"
        >
          <Badge title="Empty badge" />
          <Badge variant="outline" title="Empty outline badge" />
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Card" description="内容容器；Header / Content / Footer / Action 都是独立导出，可自由取舍。">
        <Example title="Full composition" description="标题、描述、右上角操作与底部按钮组成的完整卡片。">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle>Deployment</CardTitle>
              <CardDescription>Updated 3 minutes ago.</CardDescription>
              <CardAction>
                <Badge variant="secondary">Ready</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="text-muted-foreground text-sm">
              卡片各分区都只负责自己的内边距，内容由消费方决定。
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">Deploy</Button>
              <Button size="sm" variant="ghost">
                Cancel
              </Button>
            </CardFooter>
          </Card>
        </Example>
        <Example title="Content only" description="边界：只保留 CardContent 的最小卡片，适合承载空态或占位内容。">
          <Card className="max-w-md">
            <CardContent className="text-muted-foreground text-sm">Nothing here yet.</CardContent>
          </Card>
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Input" description="单行文本输入；不传 value 时为非受控，宽度默认铺满容器。">
        <Example title="Basic" description="placeholder 描述期望输入；留空即空态，不做任何默认值填充。">
          <Input className="max-w-xs" placeholder="you@example.com" />
          <Input className="max-w-xs" defaultValue="hello@fenix.dev" />
        </Example>
        <Example
          title="States"
          description="边界：disabled 不接收输入，aria-invalid 触发错误态描边，readOnly 可选不可改。"
        >
          <Input className="max-w-xs" disabled placeholder="Disabled" />
          <Input className="max-w-xs" aria-invalid defaultValue="not-an-email" />
          <Input className="max-w-xs" readOnly defaultValue="read-only" />
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Textarea" description="多行文本输入；高度可通过 rows 指定，也支持内容自增长。">
        <Example title="Basic" description="rows 决定初始高度，留空即空态。">
          <Textarea className="max-w-md" rows={3} placeholder="Leave a note" />
        </Example>
        <Example title="States" description="边界：disabled 无法编辑，aria-invalid 用于配合错误提示。">
          <Textarea className="max-w-md" rows={3} disabled defaultValue="Read-only summary" />
          <Textarea className="max-w-md" rows={3} aria-invalid defaultValue="Too long" />
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Label" description="表单标签；文本与控件通过 htmlFor / id 关联，点击标签可聚焦控件。">
        <Example title="Associated control" description="htmlFor 指向控件 id，这是让辅助技术正确朗读字段名的最低要求。">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="demo-label-email">Email</Label>
            <Input id="demo-label-email" placeholder="you@example.com" />
          </div>
        </Example>
        <Example
          title="Without control"
          description="边界：省略 htmlFor 时标签不再关联任何控件，只应作为分组标题使用。"
        >
          <Label className="text-muted-foreground">Section title</Label>
        </Example>
      </ComponentBlock>

      <ComponentBlock name="InputGroup" description="输入框与前后缀、按钮的组合容器；对齐方式由 addon 的 align 决定。">
        <Example title="Inline addons" description="inline-start / inline-end 把前缀与操作按钮贴在输入框两侧。">
          <InputGroup className="max-w-xs">
            <InputGroupAddon>
              <InputGroupText>https://</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput placeholder="fenix.dev" />
          </InputGroup>
          <InputGroup className="max-w-xs">
            <InputGroupInput placeholder="Search components" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton>Go</InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Example>
        <Example
          title="Block addons / disabled"
          description="边界：整组禁用后输入不可编辑，addon 随组一起降透明度；空态由 placeholder 提示。"
        >
          <InputGroup>
            <InputGroupAddon align="block-start">
              <InputGroupText>Prompt</InputGroupText>
            </InputGroupAddon>
            <InputGroupTextarea rows={2} placeholder="Describe the task" />
            <InputGroupAddon align="block-end">
              <InputGroupText>Enter to send</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          <InputGroup className="max-w-xs">
            <InputGroupAddon>
              <InputGroupText>$</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput disabled placeholder="0.00" />
          </InputGroup>
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Separator" description="分隔线；默认水平且 decorative=true，即纯装饰、不进入可访问性树。">
        <Example title="Horizontal" description="默认横向并占满容器宽度，常用 margin 工具类控制间距。">
          <div className="w-full max-w-md">
            <p className="text-sm">Above</p>
            <Separator className="my-3" />
            <p className="text-sm">Below</p>
          </div>
        </Example>
        <Example
          title="Vertical / semantic"
          description="边界：纵向分隔需要父容器有确定高度；decorative=false 时带 role=separator。"
        >
          <div className="flex h-6 items-center gap-3">
            <span className="text-sm">Draft</span>
            <Separator orientation="vertical" />
            <span className="text-sm">Published</span>
          </div>
          <div className="w-full max-w-md">
            <p className="text-sm">Group A</p>
            <Separator decorative={false} className="my-3" />
            <p className="text-sm">Group B</p>
          </div>
        </Example>
      </ComponentBlock>

      <ComponentBlock name="ScrollArea" description="自定义滚动条容器；内容未超出时既不可滚动也不显示滚动条。">
        <Example title="Vertical" description="限制高度后内容溢出，右侧出现细滚动条。">
          <ScrollArea className="h-40 w-full max-w-xs rounded-md border p-3">
            <div className="flex flex-col gap-2 text-sm">
              {SCROLL_ITEMS.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </ScrollArea>
        </Example>
        <Example title="Horizontal" description="横向滚动需要显式追加 ScrollBar orientation=horizontal。">
          <ScrollArea className="w-full max-w-sm rounded-md border">
            <div className="flex gap-3 p-3">
              {SCROLL_TILES.map((tile) => (
                <div
                  key={tile}
                  className="bg-muted flex size-16 shrink-0 items-center justify-center rounded-md text-xs"
                >
                  {tile}
                </div>
              ))}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </Example>
        <Example title="Short content" description="边界：内容不足一屏时保持原样，不出现滚动条（与空态同形）。">
          <ScrollArea className="h-24 w-full max-w-xs rounded-md border p-3">
            <span className="text-sm">Only one line.</span>
          </ScrollArea>
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Accordion" description="折叠面板；type 决定单开还是多开，collapsible 允许全部收起。">
        <Example title="Single" description="type=single + collapsible：同时只展开一项，且可以全部收起。">
          <Accordion className="w-full max-w-md" type="single" collapsible>
            <AccordionItem value="what">
              <AccordionTrigger>What is included?</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">面板内容按需渲染，收起时不可见。</AccordionContent>
            </AccordionItem>
            <AccordionItem value="how">
              <AccordionTrigger>How do I install it?</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">从 barrel 或子路径导入即可。</AccordionContent>
            </AccordionItem>
          </Accordion>
        </Example>
        <Example title="Multiple" description="type=multiple：各项独立展开，defaultValue 决定初始展开项。">
          <Accordion className="w-full max-w-md" type="multiple" defaultValue={["first"]}>
            <AccordionItem value="first">
              <AccordionTrigger>Opened by default</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">defaultValue 中的项初始即展开。</AccordionContent>
            </AccordionItem>
            <AccordionItem value="second">
              <AccordionTrigger>Closed by default</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">其余项默认为收起状态。</AccordionContent>
            </AccordionItem>
          </Accordion>
        </Example>
        <Example title="Disabled item" description="边界：单项 disabled 时既不能展开，也不参与面板间的键盘导航。">
          <Accordion className="w-full max-w-md" type="single" collapsible>
            <AccordionItem value="locked" disabled>
              <AccordionTrigger>Locked section</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">内容永远不会展开。</AccordionContent>
            </AccordionItem>
          </Accordion>
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Collapsible" description="最简折叠容器；一个触发器对应一个内容区。">
        <Example title="Basic" description="默认收起，触发器用 asChild 复用 Button 的样式与语义。">
          <Collapsible className="w-full max-w-sm">
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="outline">
                Toggle details
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="text-muted-foreground mt-3 text-sm">
              内容区在收起时不渲染可见内容。
            </CollapsibleContent>
          </Collapsible>
        </Example>
        <Example title="Disabled" description="边界：disabled 后触发器不响应点击，内容保持初始（收起）状态。">
          <Collapsible className="w-full max-w-sm" disabled>
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="outline" disabled>
                Unavailable
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="text-muted-foreground mt-3 text-sm">永远不会展开。</CollapsibleContent>
          </Collapsible>
        </Example>
      </ComponentBlock>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          Resizable
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
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

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          Tabs
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
            line 变体：面板切换是纯客户端行为，不产生浮层；内容面板可放任意组合内容。
          </p>
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
    </>
  );
}
