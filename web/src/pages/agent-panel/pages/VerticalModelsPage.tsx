import { Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { NS } from "@/src/i18n";

interface VerticalModel {
  id: string;
  name: string;
  emoji: string;
  image?: string;
  baseModel: string;
  modelType: string;
  enterprise: string;
  description: string;
  tags: string[];
  capabilities: string[];
  effects: { metric: string; value: string; desc: string }[];
  scenes: string[];
}

const ALL_MODELS: VerticalModel[] = [
  {
    id: "wind-logistics",
    name: "风机物流运输合规性检测模型",
    emoji: "🚛",
    image: "/brand/models/wind-logistics.jpeg",
    baseModel: "Qwen3-VL-2B",
    modelType: "多模态视觉模型",
    enterprise: "金风科技",
    description:
      "结合风机运输行业规范与企业标准进行专有数据精调，可自动识别运输过程中绑扎固定、防雨防潮、超限标识等关键合规项。通过图片上传即可实时输出检测结果与不合规告警，显著提升风机大部件物流运输的质量管控效率与标准化水平。",
    tags: ["物流合规", "多模态检测"],
    capabilities: ["绑扎固定检测", "防雨防潮检测", "超限标识检测", "合规报告生成"],
    effects: [
      { metric: "质检效率", value: "↑300%", desc: "替代人工逐张审核照片" },
      { metric: "误检率", value: "<2%", desc: "基于行业规范精调" },
    ],
    scenes: ["风电物流", "大件运输", "工业品运输"],
  },
  {
    id: "ppe-detection",
    name: "人员PPE检测模型",
    emoji: "🦺",
    image: "/brand/models/ppe-detection.jpeg",
    baseModel: "Qwen3-VL-8B-Instruct",
    modelType: "多模态视觉模型",
    enterprise: "金风科技",
    description:
      "结合企业安全管理制度中对上岗着装的具体要求进行专项训练，可自动识别安全帽、反光衣、防护手套、劳保鞋等个人防护装备的穿戴情况。工人进入作业区域前通过摄像头实时检测，不合规即时告警并留存记录，有效降低人为漏检风险，筑牢生产一线安全防线。",
    tags: ["安全生产", "实时检测"],
    capabilities: ["安全帽检测", "反光衣检测", "防护手套检测", "劳保鞋检测", "护目镜检测", "口罩检测"],
    effects: [
      { metric: "检测准确率", value: "95%+", desc: "多角度、多光照稳定识别" },
      { metric: "告警响应", value: "<0.5s", desc: "端侧推理，无需云端延迟" },
      { metric: "漏检率下降", value: "↓80%", desc: "替代人工逐项核验" },
    ],
    scenes: ["生产车间", "建筑工地", "仓储物流", "化工园区"],
  },
  {
    id: "wind-assembly",
    name: "风机装配质量检测模型",
    emoji: "⚙️",
    image: "/brand/models/wind-assembly.png",
    baseModel: "Qwen3-VL-32B",
    modelType: "多模态 + 知识库增强",
    enterprise: "金风科技",
    description:
      "基于工序工艺知识库，针对风机组装过程中扭矩紧固、对中校准、密封装配等关键工序，将工艺规范中的监测点转化为可自动识别的检测项。通过 AI 眼镜实时采集图像并与工艺标准比对，即时输出检测结论与偏差数据，替代传统人工逐项核验。",
    tags: ["质量管控", "AI眼镜"],
    capabilities: ["扭矩紧固检测", "对中校准检测", "密封装配检测", "偏差数据记录"],
    effects: [
      { metric: "质检效率", value: "↑5x", desc: "AI 眼镜实时比对" },
      { metric: "一次合格率", value: "+15%", desc: "关键工序实时纠偏" },
    ],
    scenes: ["精密装配", "质量检验", "工艺巡检"],
  },
  {
    id: "power-dispatch",
    name: "电力抢修智能调度模型",
    emoji: "⚡",
    image: "/brand/models/power-dispatch.png",
    baseModel: "Qwen3-4B",
    modelType: "文本模型",
    enterprise: "南方电网",
    description:
      "实时接收电力故障工单，自动解析事故地点与故障类型，结合抢修人员的实时位置、技能匹配度、在忙状态及预计到达时间等多维约束，动态计算最优派单方案并生成抢修计划。替代传统人工电话派单模式，故障响应时间大幅缩短，调度效率与资源利用率显著提升。",
    tags: ["智能调度", "运筹优化"],
    capabilities: ["故障工单解析", "人员技能匹配", "多约束路径规划", "抢修计划生成"],
    effects: [
      { metric: "响应时间", value: "↓60%", desc: "替代人工电话派单" },
      { metric: "调度效率", value: "↑3x", desc: "动态最优派单" },
    ],
    scenes: ["电力抢修", "应急调度", "运维管理"],
  },
];

export function VerticalModelsPage() {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [search, setSearch] = useState("");

  const filtered = ALL_MODELS.filter(
    (m) =>
      !search ||
      m.name.includes(search) ||
      m.description.includes(search) ||
      m.tags.some((tag) => tag.includes(search)) ||
      m.scenes.some((s) => s.includes(search)),
  );

  return (
    <div className="flex flex-col flex-1 h-full overflow-auto">
      <div className="px-8 pt-8 pb-0">
        <h1 className="text-xl font-bold text-text-primary">{t("verticalModels")}</h1>
        <p className="mt-1.5 text-sm text-text-secondary">{t("verticalModelsSubtitle")}</p>
      </div>

      {/* 搜索栏 */}
      <div className="px-8 pt-5 pb-2">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-muted" />
          <Input
            className="pl-9"
            placeholder="搜索模型名称、描述、标签、场景..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="px-8 py-4 flex flex-col gap-4">
        {filtered.map((model) => (
          <div key={model.id} className="rounded-lg border bg-card p-5">
            <div className="flex gap-6">
              {/* 左栏 — 头部 + 简介 + 能力 + 场景 */}
              <div className="flex-[1.2] min-w-0">
                {/* 头部 */}
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-50 to-blue-100 flex items-center justify-center flex-shrink-0 text-xl">
                    {model.emoji}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-bold text-text-primary">{model.name}</span>
                      <Badge
                        variant="outline"
                        className="bg-amber-50 text-amber-700 border-amber-200 text-xs px-1.5 py-0 h-auto"
                      >
                        已落地
                      </Badge>
                    </div>
                    <p className="text-sm text-text-secondary mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono bg-surface-1 px-1.5 py-px rounded text-xs">{model.baseModel}</span>
                      <span>{model.modelType}</span>
                      <span className="mx-0.5">·</span>
                      <span>{model.enterprise}</span>
                    </p>
                  </div>
                </div>

                <h4 className="text-sm font-bold text-text-primary mt-4 mb-2">模型简介</h4>
                <p className="text-sm text-text-secondary leading-relaxed mb-5">{model.description}</p>

                {model.capabilities.length > 0 && (
                  <>
                    <h4 className="text-sm font-bold text-text-primary mb-2">核心能力</h4>
                    <div className="grid grid-cols-2 gap-1.5">
                      {model.capabilities.map((c) => (
                        <div key={c} className="flex items-center gap-1.5 text-sm text-text-secondary">
                          <span className="text-green-500 flex-shrink-0">✓</span>
                          <span className="truncate">{c}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {model.scenes.length > 0 && (
                  <div className="mt-4">
                    <h4 className="text-sm font-bold text-text-primary mb-2">适用场景</h4>
                    <div className="flex gap-1.5 flex-wrap">
                      {model.scenes.map((s) => (
                        <span key={s} className="text-sm text-text-secondary bg-surface-1 px-2.5 py-1 rounded">
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* 右栏 — 图片 */}
              <div className="flex-[0.8] min-w-0">
                {model.image && (
                  <div className="rounded-lg border bg-surface-0 overflow-hidden">
                    <img
                      src={`${import.meta.env.BASE_URL}${model.image.replace(/^\//, "")}`}
                      alt={model.name}
                      className="w-full h-auto object-contain"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export type { VerticalModel };
