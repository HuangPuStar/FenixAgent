import {
  Button,
  Calendar,
  Checkbox,
  DatePicker,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Label,
  Pagination,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Slider,
  Switch,
} from "@fenix/ui-components";
import { zodResolver } from "@hookform/resolvers/zod";
import { type ReactNode, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod/v4";

import { DEMO_NS } from "../i18n";

/**
 * 表单分区：Checkbox / Switch / Slider / Select / Form / Calendar / DatePicker / Pagination。
 *
 * 布局仿 antd 官网：每个组件一个小节（标题 + 一句话说明），小节内并列 2~3 个示例
 * （h3 标题 + 说明 + 并排演示区）。每个组件的示例集合至少包含一个边界示例
 * （disabled / 空态 / 未选中 / 单页 / 校验失败），并在说明里点明边界含义。
 *
 * 导出名被 demo/App.tsx 引用，新增示例时保持导出名与签名不变。
 */

/** Select 的可选项；用常量数组而非内联字面量，避免重复渲染时重建列表。 */
const PLAN_OPTIONS = ["Starter", "Team", "Enterprise"];
const REGION_OPTIONS = ["Asia Pacific", "Europe", "North America"];

/** 演示用的「今天」：让「未来日期不可选」的边界与运行时间保持一致。 */
const TODAY = new Date();

/** 表单校验 schema；demo 只用一个字段，演示 zodResolver 与 react-hook-form 的接线方式。 */
const formSchema = z.object({
  email: z.email("Enter a valid email address"),
});

type FormValues = z.infer<typeof formSchema>;

/**
 * Pagination 的文案函数由消费方注入 —— 包内不持有 i18n 实例，也不认识宿主的命名空间。
 * 这里用桩函数演示契约：只翻译组件实际用到的两个键，其余键回退为键名本身以便暴露遗漏。
 */
const paginationT = (key: string, opts?: Record<string, unknown>): string => {
  if (key.endsWith("pagination_total")) return `Total ${String(opts?.total ?? 0)}`;
  if (key.endsWith("pagination_page_size")) return `${String(opts?.size ?? 0)} / page`;
  return key;
};

/** 组件小节：h2 标题 + 说明 + 若干示例。demo 内部结构件，不属于包公开面。 */
function ComponentBlock({ name, description, children }: { name: string; description: string; children: ReactNode }) {
  return (
    <div className="demo-example">
      <h2 className="demo-example-title">{name}</h2>
      <p className="demo-hint">{description}</p>
      <div className="mt-4 flex flex-col gap-6">{children}</div>
    </div>
  );
}

/** 小节内的单个示例：h3 标题 + 说明 + 并排演示区。children 直接进入 flex 演示区。 */
function Example({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="demo-hint">{description}</p>
      <div className="demo-row mt-3">{children}</div>
    </section>
  );
}

/** 最小可用表单：单字段 + zod 校验；直接提交空值即可看到 FormMessage 的错误态。 */
function MinimalForm() {
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "" },
  });
  const [submitted, setSubmitted] = useState("");

  return (
    <Form {...form}>
      <form
        className="w-full max-w-sm space-y-4"
        onSubmit={form.handleSubmit((values) => {
          setSubmitted(values.email);
        })}
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input placeholder="you@example.com" {...field} />
              </FormControl>
              <FormDescription>校验失败时错误文案由 FormMessage 渲染。</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button size="sm" type="submit">
          Submit
        </Button>
        {submitted ? <p className="demo-hint">Submitted: {submitted}</p> : null}
      </form>
    </Form>
  );
}

/** 边界表单：必填项为空且提交按钮禁用，对应「尚未满足校验、不允许提交」的空态。 */
function DisabledSubmitForm() {
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "" },
  });

  return (
    <Form {...form}>
      <form className="w-full max-w-sm space-y-4">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input aria-invalid placeholder="Required" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button disabled size="sm" type="submit" variant="outline">
          Submit (disabled)
        </Button>
      </form>
    </Form>
  );
}

/** Calendar 的受控示例：选中值由消费方持有，未选中时即空态。 */
function SingleCalendar() {
  const [selected, setSelected] = useState<Date | undefined>();

  return <Calendar mode="single" selected={selected} onSelect={setSelected} />;
}

/** DatePicker 的受控示例：空值与已有值都能通过 value/onChange 表达。 */
function ControlledDatePicker() {
  const [date, setDate] = useState<Date | undefined>(TODAY);

  return (
    <DatePicker
      locale="en-US"
      placeholder="Pick a date"
      value={date}
      onChange={(next) => {
        setDate(next);
      }}
    />
  );
}

export function FormsSection() {
  const { t } = useTranslation(DEMO_NS);
  const [page, setPage] = useState(2);
  const [pageSize, setPageSize] = useState(20);
  const [longPage, setLongPage] = useState(10);
  const [singlePage, setSinglePage] = useState(1);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.forms")}</h1>

      <ComponentBlock name="Checkbox" description="复选框；配合 Label 使用 htmlFor / id 建立关联。">
        <Example title="Basic" description="选中、未选中与不确定态；不确定态常用于「部分子项选中」。">
          <div className="demo-row">
            <Checkbox defaultChecked id="demo-checkbox-on" />
            <Label htmlFor="demo-checkbox-on">Checked</Label>
          </div>
          <div className="demo-row">
            <Checkbox id="demo-checkbox-off" />
            <Label htmlFor="demo-checkbox-off">Unchecked</Label>
          </div>
          <div className="demo-row">
            <Checkbox defaultChecked="indeterminate" id="demo-checkbox-mixed" />
            <Label htmlFor="demo-checkbox-mixed">Indeterminate</Label>
          </div>
        </Example>
        <Example title="Disabled" description="边界：disabled 后无法切换，勾选状态由初始值决定。">
          <div className="demo-row">
            <Checkbox defaultChecked disabled id="demo-checkbox-disabled-on" />
            <Label htmlFor="demo-checkbox-disabled-on">Disabled + checked</Label>
          </div>
          <div className="demo-row">
            <Checkbox disabled id="demo-checkbox-disabled-off" />
            <Label htmlFor="demo-checkbox-disabled-off">Disabled + unchecked</Label>
          </div>
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Switch" description="开关；size 支持 default / sm，其余与复选框一致。">
        <Example title="Basic" description="开与关的两种状态，默认尺寸沿用 size=default。">
          <div className="demo-row">
            <Switch defaultChecked id="demo-switch-on" />
            <Label htmlFor="demo-switch-on">On</Label>
          </div>
          <div className="demo-row">
            <Switch id="demo-switch-off" />
            <Label htmlFor="demo-switch-off">Off</Label>
          </div>
        </Example>
        <Example title="Small / disabled" description="边界：disabled 的开关不响应点击；size=sm 用于紧凑列表。">
          <div className="demo-row">
            <Switch defaultChecked size="sm" id="demo-switch-small" />
            <Label htmlFor="demo-switch-small">Small</Label>
          </div>
          <div className="demo-row">
            <Switch defaultChecked disabled id="demo-switch-disabled" />
            <Label htmlFor="demo-switch-disabled">Disabled</Label>
          </div>
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Slider" description="滑块；value 恒为数组，单值取一个元素，区间取两个元素。">
        <Example title="Single value" description="min / max / step 决定取值范围与步进，默认从 0 到 100。">
          <Slider aria-label="Threshold" className="max-w-xs" defaultValue={[40]} max={100} step={1} />
        </Example>
        <Example
          title="Range / disabled"
          description="边界：disabled 后滑块不可拖动；区间滑块的两个手柄分别对应数组元素。"
        >
          <Slider aria-label="Range" className="max-w-xs" defaultValue={[20, 60]} max={100} step={5} />
          <Slider aria-label="Disabled slider" className="max-w-xs" defaultValue={[30]} disabled max={100} step={1} />
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Select" description="下拉选择；触发器宽度需要显式指定，占位文案在未选择时出现。">
        <Example title="Basic" description="placeholder 描述期望选择，未选择即空态。">
          <Select>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select a plan" />
            </SelectTrigger>
            <SelectContent>
              {PLAN_OPTIONS.map((plan) => (
                <SelectItem key={plan} value={plan}>
                  {plan}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Example>
        <Example title="Grouped" description="选项较多时用 SelectGroup + SelectLabel 分组，再以分隔线区隔。">
          <Select>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select a region" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Regions</SelectLabel>
                {REGION_OPTIONS.map((region) => (
                  <SelectItem key={region} value={region}>
                    {region}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectSeparator />
              <SelectItem value="global">Global</SelectItem>
            </SelectContent>
          </Select>
        </Example>
        <Example title="Disabled" description="边界：disabled 的触发器不可展开，也不会响应键盘操作。">
          <Select disabled>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Unavailable" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
            </SelectContent>
          </Select>
        </Example>
      </ComponentBlock>

      <ComponentBlock
        name="Form"
        description="react-hook-form + zod：Form 是 FormProvider，字段用 FormField + FormControl 接线。"
      >
        <Example
          title="Minimal form"
          description="直接提交空表单即边界：zod 校验失败，错误文案出现在 FormMessage 位置。"
        >
          <MinimalForm />
        </Example>
        <Example
          title="Disabled submit"
          description="边界：必填项为空时提交按钮保持 disabled，避免提交必然失败的表单。"
        >
          <DisabledSubmitForm />
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Calendar" description="日期选择面板；选中值由消费方持有，disabled 接收任意匹配器。">
        <Example title="Single" description="未选中任何日期时面板保持空态，仅高亮今天。">
          <SingleCalendar />
        </Example>
        <Example title="Selected / restricted" description="边界：after 匹配器禁用今天之后的所有日期，今天为可选上限。">
          <Calendar disabled={{ after: TODAY }} mode="single" selected={TODAY} />
        </Example>
        <Example title="All disabled" description="边界：disabled 传 true 时整块面板不可交互，用于只读展示。">
          <Calendar disabled mode="single" />
        </Example>
      </ComponentBlock>

      <ComponentBlock
        name="DatePicker"
        description="由 Popover 与 Calendar 组合；日期文本按 locale 格式化，缺省时用运行环境区域。"
      >
        <Example title="Empty" description="边界：未传 value 时触发器显示 placeholder，不出现任何日期文本。">
          <DatePicker className="max-w-xs" placeholder="Pick a date" />
        </Example>
        <Example
          title="Controlled"
          description="受控用法：value / onChange 成对出现，并可通过 locale 指定日期格式区域。"
        >
          <ControlledDatePicker />
        </Example>
        <Example title="Disabled" description="边界：disabled 后触发器不可点击，日历弹层无法打开。">
          <DatePicker className="max-w-xs" disabled placeholder="Locked" />
        </Example>
      </ComponentBlock>

      <ComponentBlock name="Pagination" description="分页条；文案与页码状态都由消费方注入，组件自身不持有时序状态。">
        <Example
          title="Interactive"
          description="传入 onPageSizeChange 才会出现每页条数选择器，切换条数时会回到第 1 页。"
        >
          <Pagination
            page={page}
            pageSize={pageSize}
            t={paginationT}
            total={92}
            totalPages={5}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </Example>
        <Example title="Ellipsis" description="总页数超过 7 页时中间页码折叠为省略号，首尾页始终可见。">
          <Pagination
            page={longPage}
            pageSize={20}
            t={paginationT}
            total={186}
            totalPages={10}
            onPageChange={setLongPage}
          />
        </Example>
        <Example
          title="Single page"
          description="边界：只有一页时上一个 / 下一个按钮均为 disabled；未传 onPageSizeChange 则隐藏条数选择器。"
        >
          <Pagination
            page={singlePage}
            pageSize={20}
            t={paginationT}
            total={8}
            totalPages={1}
            onPageChange={setSinglePage}
          />
        </Example>
      </ComponentBlock>
    </section>
  );
}
