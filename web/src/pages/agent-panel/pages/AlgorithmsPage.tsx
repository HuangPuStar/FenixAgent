import { Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  {
    id: "lightgbm",
    name: "LightGBM",
    emoji: "💡",
    categories: ["分类", "回归", "排序"],
    description:
      "微软开源的梯度提升框架，基于直方图算法和 Leaf-wise 生长策略，训练速度极快，内存占用低，百万级样本轻松驾驭。",
    code: "from lightgbm import LGBMClassifier\n\nmodel = LGBMClassifier(\n    n_estimators=100,\n    num_leaves=31,\n    learning_rate=0.1,\n    feature_fraction=0.8\n)\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)",
    params: [
      { name: "n_estimators", default: "100", desc: "迭代轮数" },
      { name: "num_leaves", default: "31", desc: "叶子节点数" },
      { name: "learning_rate", default: "0.1", desc: "学习率" },
      { name: "feature_fraction", default: "0.8", desc: "特征采样比" },
      { name: "bagging_fraction", default: "0.8", desc: "样本采样比" },
    ],
    scenes: ["广告点击率预估", "信贷评分", "故障预警"],
  },
  {
    id: "svm",
    name: "SVM 支持向量机",
    emoji: "🎯",
    categories: ["分类", "回归"],
    description:
      "经典监督学习算法，通过寻找最大间隔超平面进行分类，配合核函数可处理非线性问题，在小样本高维场景中表现突出。",
    code: "from sklearn.svm import SVC\n\nmodel = SVC(\n    kernel='rbf',\n    C=1.0,\n    gamma='scale',\n    probability=True\n)\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)",
    params: [
      { name: "kernel", default: "rbf", desc: "核函数类型" },
      { name: "C", default: "1.0", desc: "正则化参数" },
      { name: "gamma", default: "scale", desc: "RBF 核系数" },
      { name: "probability", default: "True", desc: "是否启用概率估计" },
    ],
    scenes: ["文本分类", "图像识别", "生物信息学"],
  },
  {
    id: "decision-tree",
    name: "决策树",
    emoji: "🌳",
    categories: ["分类", "回归"],
    description: "树结构模型，通过递归划分特征空间进行决策，可解释性极佳，可作为集成学习的基模型或独立使用。",
    code: "from sklearn.tree import DecisionTreeClassifier\n\nmodel = DecisionTreeClassifier(\n    max_depth=5,\n    min_samples_leaf=10,\n    criterion='gini'\n)\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)",
    params: [
      { name: "max_depth", default: "5", desc: "树最大深度" },
      { name: "min_samples_leaf", default: "10", desc: "叶节点最小样本数" },
      { name: "criterion", default: "gini", desc: "分裂标准" },
    ],
    scenes: ["规则挖掘", "客户分层", "故障诊断"],
  },
  {
    id: "dbscan",
    name: "DBSCAN",
    emoji: "🫧",
    categories: ["聚类"],
    description: "基于密度的空间聚类算法，无需预设簇数，能发现任意形状簇并自动识别噪声点，对异常值鲁棒。",
    code: "from sklearn.cluster import DBSCAN\n\nmodel = DBSCAN(\n    eps=0.5,\n    min_samples=5,\n    metric='euclidean'\n)\nlabels = model.fit_predict(X)",
    params: [
      { name: "eps", default: "0.5", desc: "邻域半径" },
      { name: "min_samples", default: "5", desc: "核心点最小邻居数" },
      { name: "metric", default: "euclidean", desc: "距离度量方式" },
    ],
    scenes: ["地理热区分析", "异常轨迹检测", "社交网络社群发现"],
  },
  {
    id: "naive-bayes",
    name: "朴素贝叶斯",
    emoji: "📬",
    categories: ["分类"],
    description: "基于贝叶斯定理的简单高效分类器，假设特征条件独立，训练极快，在文本分类任务中表现出色。",
    code: "from sklearn.naive_bayes import GaussianNB\n\nmodel = GaussianNB()\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)",
    params: [
      { name: "var_smoothing", default: "1e-9", desc: "方差平滑系数" },
      { name: "priors", default: "None", desc: "先验概率" },
    ],
    scenes: ["垃圾邮件过滤", "新闻分类", "情感分析"],
  },
  {
    id: "knn",
    name: "KNN 最近邻",
    emoji: "👥",
    categories: ["分类", "回归"],
    description: "惰性学习算法，通过距离度量查找 K 个最近样本进行投票预测，无需训练阶段，直观易懂。",
    code: "from sklearn.neighbors import KNeighborsClassifier\n\nmodel = KNeighborsClassifier(\n    n_neighbors=5,\n    weights='uniform',\n    p=2\n)\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)",
    params: [
      { name: "n_neighbors", default: "5", desc: "邻居数量" },
      { name: "weights", default: "uniform", desc: "邻居权重策略" },
      { name: "p", default: "2", desc: "闵氏距离参数 (2=欧氏)" },
    ],
    scenes: ["推荐系统", "手写数字识别", "客户细分"],
  },
  {
    id: "isolation-forest",
    name: "孤立森林",
    emoji: "🕵️",
    categories: ["异常检测"],
    description: "无监督异常检测算法，通过随机切割特征空间隔离异常点，异常点路径短，计算高效，适合高维数据。",
    code: "from sklearn.ensemble import IsolationForest\n\nmodel = IsolationForest(\n    n_estimators=100,\n    contamination=0.1,\n    random_state=42\n)\nlabels = model.fit_predict(X)\n# -1 表示异常，1 表示正常",
    params: [
      { name: "n_estimators", default: "100", desc: "集成树数量" },
      { name: "contamination", default: "0.1", desc: "异常比例预估值" },
      { name: "max_samples", default: "auto", desc: "每棵树采样数" },
    ],
    scenes: ["交易反欺诈", "设备异常监控", "日志异常检测"],
  },
  {
    id: "lasso",
    name: "Lasso 回归",
    emoji: "📐",
    categories: ["回归"],
    description: "带 L1 正则化的线性回归，在拟合数据的同时自动进行特征选择，将不重要的系数压缩为零，生成稀疏模型。",
    code: "from sklearn.linear_model import Lasso\n\nmodel = Lasso(\n    alpha=1.0,\n    max_iter=1000,\n    tol=0.0001\n)\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)",
    params: [
      { name: "alpha", default: "1.0", desc: "L1 正则化强度" },
      { name: "max_iter", default: "1000", desc: "最大迭代次数" },
      { name: "tol", default: "0.0001", desc: "收敛容忍度" },
    ],
    scenes: ["特征选择", "高维稀疏回归", "基因组关联分析"],
  },
  {
    id: "ridge",
    name: "岭回归",
    emoji: "🏔️",
    categories: ["回归"],
    description: "带 L2 正则化的线性回归，通过收缩系数降低模型复杂度，有效解决多重共线性问题，稳定性优于普通最小二乘。",
    code: "from sklearn.linear_model import Ridge\n\nmodel = Ridge(\n    alpha=1.0,\n    solver='auto'\n)\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)",
    params: [
      { name: "alpha", default: "1.0", desc: "L2 正则化强度" },
      { name: "solver", default: "auto", desc: "优化求解器" },
    ],
    scenes: ["经济预测", "需求预估", "多变量回归"],
  },
  {
    id: "gbdt",
    name: "GBDT 梯度提升树",
    emoji: "📊",
    categories: ["分类", "回归"],
    description:
      "经典集成学习算法，每次迭代拟合前一棵树的残差，逐步降低偏差，是 XGBoost 与 LightGBM 的前身与理论基础。",
    code: "from sklearn.ensemble import GradientBoostingClassifier\n\nmodel = GradientBoostingClassifier(\n    n_estimators=100,\n    learning_rate=0.1,\n    max_depth=3\n)\nmodel.fit(X_train, y_train)\ny_pred = model.predict(X_test)",
    params: [
      { name: "n_estimators", default: "100", desc: "弱学习器数量" },
      { name: "learning_rate", default: "0.1", desc: "学习率/收缩率" },
      { name: "max_depth", default: "3", desc: "单棵树最大深度" },
      { name: "subsample", default: "1.0", desc: "训练样本采样比" },
    ],
    scenes: ["回归预测", "排序任务", "时序异常检测"],
  },
  {
    id: "svd",
    name: "SVD 奇异值分解",
    emoji: "✂️",
    categories: ["降维"],
    description: "矩阵分解降维算法，将原始矩阵分解为正交矩阵与奇异值对角阵，广泛应用于推荐系统、信号去噪和语义分析。",
    code: "from sklearn.decomposition import TruncatedSVD\n\nsvd = TruncatedSVD(\n    n_components=100,\n    random_state=42\n)\nX_reduced = svd.fit_transform(X)",
    params: [
      { name: "n_components", default: "100", desc: "保留的奇异值数" },
      { name: "n_iter", default: "5", desc: "随机 SVD 迭代次数" },
    ],
    scenes: ["推荐系统矩阵分解", "文本主题建模", "图像压缩"],
  },
  {
    id: "arima",
    name: "ARIMA 时序模型",
    emoji: "⏳",
    categories: ["时序预测"],
    description: "自回归积分滑动平均模型，通过差分将非平稳序列平稳化后建模，是单变量时序预测的经典基准方法。",
    code: "from statsmodels.tsa.arima.model import ARIMA\n\nmodel = ARIMA(\n    series,\n    order=(2, 1, 2)\n)\nfitted = model.fit()\nforecast = fitted.forecast(steps=30)",
    params: [
      { name: "p", default: "2", desc: "自回归项数" },
      { name: "d", default: "1", desc: "差分阶数" },
      { name: "q", default: "2", desc: "移动平均项数" },
    ],
    scenes: ["电力负荷预测", "交通流量预测", "库存需求预测"],
  },
  {
    id: "transformer",
    name: "Transformer",
    emoji: "🤖",
    categories: ["深度学习"],
    description:
      "基于自注意力机制的深度学习架构，是现代大语言模型（GPT、BERT）的基石，在 NLP、CV、多模态领域全面领先。",
    code: "import torch\nimport torch.nn as nn\n\nclass TransformerBlock(nn.Module):\n    def __init__(self, d_model, nhead):\n        super().__init__()\n        self.attn = nn.MultiheadAttention(d_model, nhead)\n        self.ff = nn.Sequential(\n            nn.Linear(d_model, d_model * 4),\n            nn.ReLU(),\n            nn.Linear(d_model * 4, d_model)\n        )\n        self.norm1 = nn.LayerNorm(d_model)\n        self.norm2 = nn.LayerNorm(d_model)\n\n    def forward(self, x):\n        attn_out, _ = self.attn(x, x, x)\n        x = self.norm1(x + attn_out)\n        x = self.norm2(x + self.ff(x))\n        return x\n\n# 训练代码根据任务定制",
    params: [
      { name: "d_model", default: "512", desc: "隐藏层维度" },
      { name: "nhead", default: "8", desc: "多头注意力头数" },
      { name: "num_layers", default: "6", desc: "Encoder/Decoder 层数" },
      { name: "dropout", default: "0.1", desc: "Dropout 比率" },
    ],
    scenes: ["机器翻译", "文本生成", "代码补全", "图像分类"],
  },
  {
    id: "collaborative-filtering",
    name: "协同过滤",
    emoji: "🔗",
    categories: ["推荐"],
    description: "基于用户行为相似性或物品相似性的推荐算法，利用集体智慧发现潜在偏好，是推荐系统的核心方法之一。",
    code: "from sklearn.metrics.pairwise import cosine_similarity\nimport numpy as np\n\n# 用户-物品评分矩阵\nuser_sim = cosine_similarity(ratings_matrix)\n\n# 基于相似用户生成推荐\ndef recommend(user_id, k=5):\n    similar = np.argsort(-user_sim[user_id])[1:k+1]\n    # 聚合相似用户的偏好生成推荐列表\n    return aggregate(similar)",
    params: [
      { name: "k", default: "5", desc: "近邻用户/物品数" },
      { name: "similarity", default: "cosine", desc: "相似度度量方式" },
      { name: "alpha", default: "0.5", desc: "ItemCF/UserCF 融合权重" },
    ],
    scenes: ["电商推荐", "视频推荐", "音乐推荐"],
  },
  {
    id: "genetic-algorithm",
    name: "遗传算法",
    emoji: "🧬",
    categories: ["优化"],
    description:
      "模拟自然选择与遗传机制的启发式搜索算法，通过选择、交叉、变异迭代进化种群，在复杂组合优化问题中表现优异。",
    code: "import random\n\nclass GeneticAlgorithm:\n    def __init__(self, pop_size=100, generations=500, mutation_rate=0.01):\n        self.pop_size = pop_size\n        self.generations = generations\n        self.mutation_rate = mutation_rate\n\n    def evolve(self, population):\n        for gen in range(self.generations):\n            fitness = [self.evaluate(ind) for ind in population]\n            # 轮盘赌选择 → 交叉 → 变异\n            population = self.next_generation(population, fitness)\n        return max(population, key=self.evaluate)",
    params: [
      { name: "pop_size", default: "100", desc: "种群规模" },
      { name: "generations", default: "500", desc: "进化代数" },
      { name: "mutation_rate", default: "0.01", desc: "变异概率" },
    ],
    scenes: ["调度优化", "路径规划", "参数寻优", "排班优化"],
  },
  {
    id: "apriori",
    name: "Apriori 关联规则",
    emoji: "🛒",
    categories: ["推荐"],
    description: "经典的关联规则挖掘算法，通过频繁项集发现商品间的强关联关系，是购物篮分析的标配工具。",
    code: 'from mlxtend.frequent_patterns import apriori, association_rules\n\nfrequent = apriori(\n    df_onehot,\n    min_support=0.05,\n    use_colnames=True\n)\nrules = association_rules(\n    frequent,\n    metric="lift",\n    min_threshold=1.0\n)',
    params: [
      { name: "min_support", default: "0.05", desc: "最小支持度" },
      { name: "min_confidence", default: "0.5", desc: "最小置信度" },
      { name: "metric", default: "lift", desc: "评估指标" },
      { name: "min_threshold", default: "1.0", desc: "评估阈值" },
    ],
    scenes: ["购物篮分析", "交叉销售", "商品捆绑推荐"],
  },
];

const CATEGORIES = ["全部", "分类", "回归", "聚类", "降维", "排序", "异常检测", "时序预测", "深度学习", "推荐", "优化"];

export function AlgorithmsPage() {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [activeCategory, setActiveCategory] = useState("全部");
  const [selectedAlgorithm, setSelectedAlgorithm] = useState<Algorithm | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const filteredByCategory =
    activeCategory === "全部" ? ALL_ALGORITHMS : ALL_ALGORITHMS.filter((a) => a.categories.includes(activeCategory));

  const filtered = searchQuery
    ? filteredByCategory.filter(
        (a) =>
          a.name.includes(searchQuery) ||
          a.description.includes(searchQuery) ||
          a.scenes.some((s) => s.includes(searchQuery)) ||
          a.categories.some((c) => c.includes(searchQuery)),
      )
    : filteredByCategory;

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

      {/* 搜索栏 */}
      <div className="px-8 pt-2 pb-2">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-muted" />
          <Input
            className="pl-9"
            placeholder="搜索算法名称、描述、场景..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onBlur={() => setSearchQuery(searchInput)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setSearchQuery(searchInput);
            }}
          />
        </div>
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
