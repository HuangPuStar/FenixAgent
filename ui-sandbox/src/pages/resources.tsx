import {
  Binary,
  Braces,
  Check,
  ChevronRight,
  Code2,
  Database,
  FileText,
  Globe2,
  Layers3,
  Search,
  Settings2,
  Share2,
  Sparkles,
  Upload,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ResourceScopeFilter } from "../components/resource-scope-filter";
import {
  FormFields,
  Modal,
  PageHeader,
  PrimaryButton,
  RowMenu,
  SearchToolbar,
  Status,
  Tag,
  Toast,
  ToolbarSummary,
} from "../components/ui";
import { RESOURCE_SCOPES, type ResourceScope } from "../lib/resource-scope";

export function ResourceFrame({
  title,
  description,
  kind,
  children,
  search,
  onSearch,
  toolbarChildren,
  resultLabel,
}: {
  title: string;
  description: string;
  kind: string;
  children: ReactNode;
  search?: string;
  onSearch?: (value: string) => void;
  toolbarChildren?: ReactNode;
  resultLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState(false);
  const save = () => {
    setOpen(false);
    setToast(true);
    window.setTimeout(() => setToast(false), 1800);
  };
  return (
    <div className="page-frame">
      <PageHeader title={title} description={description}>
        <button className="button" type="button">
          <Upload />
          导入
        </button>
        <PrimaryButton onClick={() => setOpen(true)}>添加{kind}</PrimaryButton>
      </PageHeader>
      {onSearch && (
        <SearchToolbar value={search ?? ""} onChange={onSearch} placeholder={`搜索${kind}`}>
          {toolbarChildren}
          <button className="button button--ghost" type="button">
            <Settings2 />
            更多筛选
          </button>
          {resultLabel && (
            <ToolbarSummary>
              <span>{resultLabel}</span>
            </ToolbarSummary>
          )}
        </SearchToolbar>
      )}
      {children}
      {open && (
        <Modal title={`添加${kind}`} onClose={() => setOpen(false)} onConfirm={save}>
          <FormFields kind={kind} />
        </Modal>
      )}
      {toast && <Toast text={`${kind}已添加（Mock）`} />}
    </div>
  );
}

export function VerticalModelsPage() {
  const [query, setQuery] = useState("");
  const models = [
    ["政务公文大模型", "覆盖 14 类公文与 32 个政务场景", "v3.2", "已部署", "86.4%"],
    ["装备制造知识模型", "设备诊断、工艺问答与维保建议", "v2.8", "训练中", "79.8%"],
    ["法律合同审查模型", "合同条款抽取、比对与风险识别", "v4.1", "已部署", "91.2%"],
  ].filter((row) => row.join("").includes(query));
  return (
    <ResourceFrame
      title="企业垂直大模型"
      description="管理面向行业和组织知识训练的专属模型，跟踪数据、训练、评测和部署生命周期。"
      kind="垂直模型"
      search={query}
      onSearch={setQuery}
      resultLabel={`${models.length} 个模型`}
    >
      <section className="vertical-grid">
        {models.map((model, index) => (
          <article className="panel vertical-card" key={model[0]}>
            <header>
              <span>
                <Layers3 />
              </span>
              <Status kind={model[3] === "已部署" ? "success" : "warning"}>{model[3]}</Status>
            </header>
            <h3>{model[0]}</h3>
            <p>{model[1]}</p>
            <div className="vertical-card__score">
              <span>
                综合评测<strong>{model[4]}</strong>
              </span>
              <div>
                <i style={{ width: model[4] }} />
              </div>
            </div>
            <footer>
              <span>
                <Database />
                {index === 1 ? "48.2 万" : "126.8 万"} 样本
              </span>
              <Tag tone="blue">{model[2]}</Tag>
              <button type="button">
                <ChevronRight />
              </button>
            </footer>
          </article>
        ))}
      </section>
      <section className="panel lifecycle">
        <header className="panel__header">
          <h3>模型生命周期</h3>
        </header>
        <div>
          {[
            ["1", "准备数据", "选择知识库与清洗规则"],
            ["2", "训练与微调", "配置基础模型与训练参数"],
            ["3", "评测", "在业务测试集上验证效果"],
            ["4", "发布", "灰度部署到智能体"],
          ].map(([number, title, text], index) => (
            <div key={number} className={index === 0 ? "is-active" : ""}>
              <span>{number}</span>
              <strong>{title}</strong>
              <small>{text}</small>
            </div>
          ))}
        </div>
      </section>
    </ResourceFrame>
  );
}

export function AlgorithmsPage() {
  const [query, setQuery] = useState("");
  const cards = [
    ["语义分块器", "按段落语义边界切分长文档，保留标题层级。", Braces, ["知识库", "文本处理"], "2.4k"],
    ["混合检索排序", "融合向量与关键词得分，对召回结果重新排序。", Binary, ["检索", "Rerank"], "1.8k"],
    ["表格结构提取", "识别复杂表格结构并输出规范化数据。", FileText, ["视觉", "文档"], "956"],
    ["敏感信息检测", "发现个人信息、密钥与内部敏感字段。", Check, ["安全", "审查"], "712"],
    ["图谱实体消歧", "合并多来源数据中的同名实体与关系。", Share2, ["知识图谱"], "408"],
    ["时间序列异常检测", "发现指标突变与持续偏离并解释原因。", Sparkles, ["数据分析"], "335"],
  ].filter((card) => `${card[0]}${card[1]}`.includes(query));
  return (
    <ResourceFrame
      title="算法库"
      description="沉淀可复用的数据处理与推理算法，通过稳定输入输出在工作流和 Agent 中调用。"
      kind="算法"
      search={query}
      onSearch={setQuery}
      resultLabel={`${cards.length} 个算法`}
    >
      <section className="resource-card-grid">
        {cards.map(([name, desc, Icon, tags, count]) => {
          const CardIcon = Icon as typeof Binary;
          return (
            <article className="panel resource-card" key={name as string}>
              <header>
                <span className="resource-card__icon">
                  <CardIcon />
                </span>
                <RowMenu />
              </header>
              <h3>{name as string}</h3>
              <p>{desc as string}</p>
              <div className="resource-card__tags">
                {(tags as string[]).map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </div>
              <footer>
                <span>{count as string} 次调用</span>
                <button type="button">
                  查看详情 <ChevronRight />
                </button>
              </footer>
            </article>
          );
        })}
      </section>
    </ResourceFrame>
  );
}

export function SkillsPage() {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ResourceScope>("全部");
  const allSkills = [
    ["Frontend Design", "设计并优化产品界面与交互体验", Sparkles, "设计", "本组织"],
    ["Research", "检索可信资料并整理结论", Search, "研究", "本组织"],
    ["Documents", "创建、编辑和审校办公文档", FileText, "文档", "平台"],
    ["Code Review", "检查代码规范与实现风险", Code2, "研发", "本组织"],
    ["Data Analysis", "清洗数据并生成洞察与图表", Database, "数据", "平台"],
    ["Browser Control", "查看和操作浏览器页面", Globe2, "工具", "平台"],
    ["Proposal Voice", "保留我的提案语气与评审表达习惯", FileText, "写作", "个人"],
    ["Local Release Check", "发布前执行我的本地检查清单", Check, "研发", "个人"],
  ];
  const skills = allSkills.filter(
    (skill) =>
      `${skill[0]}${skill[1]}`.toLowerCase().includes(query.toLowerCase()) && (scope === "全部" || skill[4] === scope),
  );
  const scopeCounts: Record<ResourceScope, number> = {
    全部: allSkills.length,
    个人: allSkills.filter((skill) => skill[4] === "个人").length,
    本组织: allSkills.filter((skill) => skill[4] === "本组织").length,
    平台: allSkills.filter((skill) => skill[4] === "平台").length,
  };
  return (
    <ResourceFrame
      title="技能库"
      description="以可读指令封装 Agent 的工作方法，让同一种能力在不同智能体中被一致复用。"
      kind="Skill"
      search={query}
      onSearch={setQuery}
      toolbarChildren={
        <ResourceScopeFilter value={scope} onChange={setScope} counts={scopeCounts} options={RESOURCE_SCOPES} />
      }
      resultLabel={`${skills.length} 个 Skills`}
    >
      <section className="skill-list panel">
        {skills.map(([name, desc, Icon, category, source]) => {
          const SkillIcon = Icon as typeof Sparkles;
          return (
            <button type="button" key={name as string}>
              <span className="skill-list__icon">
                <SkillIcon />
              </span>
              <span>
                <strong>{name as string}</strong>
                <small>{desc as string}</small>
              </span>
              <Tag tone={source === "本组织" ? "blue" : source === "平台" ? "green" : "amber"}>{source as string}</Tag>
              <Tag>{category as string}</Tag>
              <ChevronRight />
            </button>
          );
        })}
      </section>
    </ResourceFrame>
  );
}
