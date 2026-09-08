import { Clock3, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { ResourceScopeFilter } from "../components/resource-scope-filter";
import { PageHeader, PrimaryButton, SearchToolbar, ToolbarSummary } from "../components/ui";
import { RESOURCE_SCOPES, type ResourceScope } from "../lib/resource-scope";
import { OverlayTemplate, PageStatesTemplate } from "./design-template-feedback";
import {
  CatalogTemplate,
  CompactListTemplate,
  DataListTemplate,
  DetailHeaderTemplate,
  MasterDetailTemplate,
  TemplateSpec,
  TimelineTemplate,
} from "./design-template-modules";

const SCOPE_COUNTS: Record<ResourceScope, number> = {
  全部: 24,
  个人: 5,
  本组织: 12,
  平台: 7,
};

export function DesignTemplatesPage() {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ResourceScope>("全部");

  return (
    <div className="page-frame design-templates-page">
      <PageHeader title="沙盒模版" description="固化页面级布局与公共控件，作为后续设计页面的直接实现基线。" />

      <TemplateSpec
        title="页面 Header"
        description="标题、说明与操作区"
        componentName="PageHeader"
        notes={["标题 28px / 720", "说明 13px / 1.55", "操作区右对齐"]}
      >
        <PageHeader title="资源名称" description="一句话说明本页管理的对象、关键能力和使用边界。">
          <button className="button" type="button">
            次要操作
          </button>
          <PrimaryButton>主要操作</PrimaryButton>
        </PageHeader>
      </TemplateSpec>

      <TemplateSpec
        title="搜索与筛选栏"
        description="搜索、范围与结果概览"
        componentName="SearchToolbar"
        notes={["统一高度 38px", "圆角 9px", "页面底色直接承载，不增加外层卡片"]}
      >
        <SearchToolbar value={query} onChange={setQuery} placeholder="搜索名称、类型或关键词">
          <ResourceScopeFilter value={scope} onChange={setScope} counts={SCOPE_COUNTS} options={RESOURCE_SCOPES} />
          <ToolbarSummary>
            <span>
              <strong>24</strong> 个结果
            </span>
            <span>
              <Clock3 /> 刚刚更新
            </span>
            <button className="button button--ghost" type="button">
              <SlidersHorizontal /> 更多筛选
            </button>
          </ToolbarSummary>
        </SearchToolbar>
      </TemplateSpec>

      <TemplateSpec
        title="主从工作台"
        description="左侧资源索引，右侧详情与关联对象"
        componentName="MasterDetailLayout"
        notes={["索引宽度 220–260px", "选中态使用浅蓝底", "详情区独立滚动"]}
      >
        <MasterDetailTemplate />
      </TemplateSpec>

      <TemplateSpec
        title="紧凑资源列表"
        description="高频扫描、状态识别与行级操作"
        componentName="CompactResourceList"
        notes={["一行一个对象", "主要信息靠左", "状态与操作固定在右侧"]}
      >
        <CompactListTemplate />
      </TemplateSpec>

      <TemplateSpec
        title="标准数据列表"
        description="批量选择、排序和分页"
        componentName="DataList"
        notes={["适合结构化字段", "支持批量选择", "空结果保留表头与恢复入口"]}
      >
        <DataListTemplate />
      </TemplateSpec>

      <TemplateSpec
        title="卡片目录"
        description="用于发现、比较和选择能力"
        componentName="CatalogGrid"
        notes={["卡片信息密度一致", "描述最多两行", "主要操作位置统一"]}
      >
        <CatalogTemplate />
      </TemplateSpec>

      <TemplateSpec
        title="时间线列表"
        description="任务计划、执行历史和状态演进"
        componentName="RuntimeTimeline"
        notes={["时间是第一视觉锚点", "状态沿纵轴排列", "运行中项目单独强调"]}
      >
        <TimelineTemplate />
      </TemplateSpec>

      <TemplateSpec
        title="详情 Header"
        description="对象身份、状态、元数据和主要操作"
        componentName="DetailHeader"
        notes={["名称与 ID 同组", "状态紧邻身份信息", "危险操作不设为主按钮"]}
      >
        <DetailHeaderTemplate />
      </TemplateSpec>

      <TemplateSpec
        title="页面状态"
        description="加载、空结果、错误与重试"
        componentName="PageState"
        notes={["说明发生了什么", "给出唯一下一步", "状态切换不改变页面结构"]}
      >
        <PageStatesTemplate />
      </TemplateSpec>

      <TemplateSpec
        title="抽屉与确认弹窗"
        description="编辑上下文与高风险操作确认"
        componentName="OverlayPatterns"
        notes={["抽屉承载连续编辑", "弹窗只处理单一决策", "Esc 与遮罩均可关闭"]}
      >
        <OverlayTemplate />
      </TemplateSpec>
    </div>
  );
}
