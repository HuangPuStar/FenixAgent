import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NS } from "@/src/i18n";
import { AlgorithmDetailDialog } from "./AlgorithmDetailDialog";

interface Algorithm {
  id: string;
  name: string;
  emoji: string;
  categories: string[];
  description: string;
  code: string;
  params: { name: string; default: string; desc: string }[];
  scenes: string[];
}

const ALL_ALGORITHMS: Algorithm[] = [
  {
    id: "random-forest",
    name: "随机森林",
    emoji: "🌲",
    categories: ["分类", "回归"],
    description: "基于集成学习的分类与回归算法，通过构建多棵决策树进行投票输出结果，抗过拟合能力强。",
    code: "from sklearn.ensemble import RandomForestClassifier\n\nmodel = RandomForestClassifier(\n    n_estimators=100,\n    max_depth=None,\n    random_state=42\n)\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)",
    params: [
      { name: "n_estimators", default: "100", desc: "决策树数量" },
      { name: "max_depth", default: "None", desc: "树最大深度" },
      { name: "min_samples_split", default: "2", desc: "内部节点最小样本数" },
      { name: "random_state", default: "42", desc: "随机种子" },
    ],
    scenes: ["风控评分", "客户分群", "故障诊断"],
  },
  {
    id: "xgboost",
    name: "XGBoost",
    emoji: "⚡",
    categories: ["分类", "回归", "排序"],
    description: "梯度提升框架，在结构化/表格数据上表现优异，支持自定义损失函数和 L1/L2 正则化。",
    code: "from xgboost import XGBClassifier\n\nmodel = XGBClassifier(\n    n_estimators=100,\n    max_depth=6,\n    learning_rate=0.3,\n    subsample=1.0\n)\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)",
    params: [
      { name: "n_estimators", default: "100", desc: "基学习器数量" },
      { name: "max_depth", default: "6", desc: "树最大深度" },
      { name: "learning_rate", default: "0.3", desc: "学习率" },
      { name: "subsample", default: "1.0", desc: "训练样本采样比" },
      { name: "colsample_bytree", default: "1.0", desc: "特征采样比" },
      { name: "reg_lambda", default: "1.0", desc: "L2 正则化权重" },
    ],
    scenes: ["风控评分卡", "推荐系统排序", "异常检测", "工业预测"],
  },
  {
    id: "logistic-regression",
    name: "逻辑回归",
    emoji: "📊",
    categories: ["分类"],
    description: "经典二分类算法，通过 Sigmoid 函数映射概率输出，可解释性强、训练速度快。",
    code: 'from sklearn.linear_model import LogisticRegression\n\nmodel = LogisticRegression(\n    penalty="l2",\n    C=1.0,\n    solver="lbfgs"\n)\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)',
    params: [
      { name: "penalty", default: "l2", desc: "正则化类型" },
      { name: "C", default: "1.0", desc: "正则化强度倒数" },
      { name: "solver", default: "lbfgs", desc: "优化算法" },
    ],
    scenes: ["信用评分", "疾病诊断", "流失预测"],
  },
  {
    id: "kmeans",
    name: "K-Means",
    emoji: "🔵",
    categories: ["聚类"],
    description: "无监督聚类算法，将数据划分为 K 个簇，广泛应用于用户分群、图像分割等场景。",
    code: "from sklearn.cluster import KMeans\n\nmodel = KMeans(\n    n_clusters=3,\n    random_state=42,\n    n_init=10\n)\nlabels = model.fit_predict(X)",
    params: [
      { name: "n_clusters", default: "3", desc: "簇的数量" },
      { name: "random_state", default: "42", desc: "随机种子" },
      { name: "n_init", default: "10", desc: "初始化运行次数" },
    ],
    scenes: ["用户分群", "图像分割", "异常检测"],
  },
  {
    id: "linear-regression",
    name: "线性回归",
    emoji: "📈",
    categories: ["回归"],
    description: "最基础的回归算法，拟合自变量与因变量的线性关系。简单高效，可解释性顶级。",
    code: "from sklearn.linear_model import LinearRegression\n\nmodel = LinearRegression()\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)",
    params: [{ name: "fit_intercept", default: "True", desc: "是否计算截距" }],
    scenes: ["销量预测", "房价预估", "成本分析"],
  },
  {
    id: "pca",
    name: "PCA",
    emoji: "🧩",
    categories: ["降维"],
    description: "主成分分析降维算法，保留最大方差方向，高效压缩高维数据同时保持数据结构。",
    code: "from sklearn.decomposition import PCA\n\npca = PCA(n_components=2)\nX_reduced = pca.fit_transform(X)",
    params: [{ name: "n_components", default: "2", desc: "保留的主成分数" }],
    scenes: ["数据可视化", "特征压缩", "去噪预处理"],
  },
];

const CATEGORIES = ["全部", "分类", "回归", "聚类", "降维", "排序"];

export function AlgorithmsPage() {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [activeCategory, setActiveCategory] = useState("全部");
  const [selectedAlgorithm, setSelectedAlgorithm] = useState<Algorithm | null>(null);

  const filtered =
    activeCategory === "全部" ? ALL_ALGORITHMS : ALL_ALGORITHMS.filter((a) => a.categories.includes(activeCategory));

  return (
    <div className="flex flex-col flex-1 h-full overflow-auto">
      <div className="px-8 pt-8 pb-0">
        <h1 className="text-xl font-bold text-text-primary">{t("algorithms")}</h1>
        <p className="mt-1.5 text-sm text-text-secondary">{t("algorithmsSubtitle")}</p>
      </div>

      <div className="flex items-center gap-1.5 px-8 pt-5 pb-2">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setActiveCategory(cat)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors ${
              activeCategory === cat ? "bg-brand text-white" : "text-text-secondary hover:bg-surface-hover"
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="px-8 py-4 grid grid-cols-3 gap-4">
        {filtered.map((algo) => (
          <div
            key={algo.id}
            className="flex flex-col gap-3 rounded-lg border bg-card p-4 hover:border-brand-light hover:shadow-sm transition-all"
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-50 to-blue-100 flex items-center justify-center flex-shrink-0 text-lg">
                {algo.emoji}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-bold text-text-primary">{algo.name}</span>
                  <Badge
                    variant="outline"
                    className="bg-green-50 text-green-600 border-green-200 text-[10px] px-1.5 py-0 h-auto"
                  >
                    即插即用
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-text-secondary leading-relaxed">{algo.description}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-auto">
              <span className="text-[11px] text-text-muted">{algo.categories.join(" · ")}</span>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                className="h-auto p-0 text-xs text-brand font-medium hover:bg-transparent hover:text-brand/80"
                onClick={() => setSelectedAlgorithm(algo)}
              >
                查看详情
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto p-0 text-xs text-brand font-medium hover:bg-transparent hover:text-brand/80"
                onClick={() => {
                  void navigator.clipboard.writeText(algo.code);
                }}
              >
                复制代码
              </Button>
            </div>
          </div>
        ))}
      </div>
      {selectedAlgorithm && (
        <AlgorithmDetailDialog
          algorithm={selectedAlgorithm}
          open={!!selectedAlgorithm}
          onClose={() => setSelectedAlgorithm(null)}
        />
      )}
    </div>
  );
}

export type { Algorithm };
