import {
  BookOpen,
  Braces,
  ChevronRight,
  Cpu,
  Download,
  FileText,
  Layers3,
  RefreshCcw,
  SlidersHorizontal,
  TestTube2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { Modal, PageHeader, PrimaryButton, SearchToolbar, Status, Tag, Toast, ToolbarSummary } from "../components/ui";

interface KnowledgeBaseSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: "可用" | "同步中" | "异常";
  resources: number;
  bindings: number;
  embedding: string;
  parseMethod: string;
  chunkMethod: string;
}

interface KnowledgeResource {
  id: string;
  name: string;
  chunks: number;
  status: "已完成" | "解析中" | "失败";
  enabled: boolean;
  updatedAt: string;
}

const KNOWLEDGE_BASES: KnowledgeBaseSummary[] = [
  {
    id: "kb_policy",
    name: "政策法规库",
    slug: "policy-regulations",
    description: "政务政策、数据安全条例与公开办事指南。",
    status: "可用",
    resources: 4,
    bindings: 3,
    embedding: "BAAI/bge-m3",
    parseMethod: "通用解析",
    chunkMethod: "按标题分块",
  },
  {
    id: "kb_product",
    name: "产品技术手册",
    slug: "product-handbook",
    description: "产品安装、运维与故障排查文档。",
    status: "同步中",
    resources: 18,
    bindings: 5,
    embedding: "BAAI/bge-m3",
    parseMethod: "说明书解析",
    chunkMethod: "智能分块",
  },
  {
    id: "kb_cases",
    name: "客户案例",
    slug: "customer-cases",
    description: "已交付项目的方案、过程记录与复盘。",
    status: "可用",
    resources: 9,
    bindings: 2,
    embedding: "text-embedding-v4",
    parseMethod: "通用解析",
    chunkMethod: "智能分块",
  },
];

const INITIAL_RESOURCES: KnowledgeResource[] = [
  { id: "doc_1", name: "数字政府建设指南.pdf", chunks: 286, status: "已完成", enabled: true, updatedAt: "今天 09:42" },
  {
    id: "doc_2",
    name: "公共数据授权运营办法.docx",
    chunks: 194,
    status: "已完成",
    enabled: true,
    updatedAt: "昨天 16:08",
  },
  { id: "doc_3", name: "数据安全管理条例.pdf", chunks: 412, status: "解析中", enabled: true, updatedAt: "昨天 14:31" },
  { id: "doc_4", name: "政务服务事项清单.xlsx", chunks: 76, status: "失败", enabled: false, updatedAt: "8 月 20 日" },
];

function statusKind(status: KnowledgeResource["status"]) {
  if (status === "已完成") return "success" as const;
  if (status === "解析中") return "warning" as const;
  return "danger" as const;
}

export function KnowledgeBasesPage() {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(KNOWLEDGE_BASES[0].id);
  const [detailTab, setDetailTab] = useState<"documents" | "retrieval">("documents");
  const [resources, setResources] = useState(INITIAL_RESOURCES);
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState("");
  const bases = KNOWLEDGE_BASES.filter((base) => `${base.name}${base.slug}${base.description}`.includes(query));
  const selected = KNOWLEDGE_BASES.find((base) => base.id === selectedId) ?? KNOWLEDGE_BASES[0];

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 1800);
  };

  const toggleResource = (id: string) => {
    setResources((current) =>
      current.map((resource) => (resource.id === id ? { ...resource, enabled: !resource.enabled } : resource)),
    );
  };

  return (
    <div className="page-frame knowledge-page">
      <PageHeader title="知识库" description="管理向量知识库、文档解析与检索验证，并将可用知识绑定给 Agent。">
        <button className="button" type="button" onClick={() => notify("打开 RAGFlow 导入流程")}>
          <Download />从 RAGFlow 导入
        </button>
        <button className="button" type="button" onClick={() => notify("打开向量模型管理")}>
          <Cpu />
          向量模型
        </button>
        <PrimaryButton onClick={() => setCreateOpen(true)}>创建知识库</PrimaryButton>
      </PageHeader>

      <SearchToolbar value={query} onChange={setQuery} placeholder="搜索知识库" className="knowledge-toolbar">
        <button className="button button--ghost" type="button">
          <SlidersHorizontal />
          筛选状态
        </button>
        <ToolbarSummary>
          <span>
            <strong>{bases.length}</strong> 个知识库
          </span>
        </ToolbarSummary>
      </SearchToolbar>

      <div className="knowledge-workspace">
        <aside className="panel knowledge-directory">
          <header>
            <span>知识库</span>
            <strong>{bases.length}</strong>
          </header>
          {bases.map((base) => (
            <button
              type="button"
              className={base.id === selectedId ? "is-active" : ""}
              onClick={() => setSelectedId(base.id)}
              key={base.id}
            >
              <span className="knowledge-directory__icon">
                <BookOpen />
              </span>
              <span>
                <strong>{base.name}</strong>
                <small>
                  {base.resources} 个文档 · {base.status}
                </small>
              </span>
              <ChevronRight />
            </button>
          ))}
          {bases.length === 0 && <p>没有匹配的知识库</p>}
        </aside>

        <main className="knowledge-detail">
          <section className="panel knowledge-summary">
            <header>
              <div>
                <span
                  className={`knowledge-status is-${selected.status === "可用" ? "ready" : selected.status === "同步中" ? "syncing" : "error"}`}
                />
                <div>
                  <h3>{selected.name}</h3>
                  <code>{selected.slug}</code>
                </div>
              </div>
              <div>
                <button className="button" type="button">
                  编辑
                </button>
                <button className="button" type="button">
                  删除
                </button>
              </div>
            </header>
            <p>{selected.description}</p>
            <div className="knowledge-config">
              <span>
                <Cpu />
                <small>向量模型</small>
                <strong>{selected.embedding}</strong>
              </span>
              <span>
                <Layers3 />
                <small>解析方式</small>
                <strong>{selected.parseMethod}</strong>
              </span>
              <span>
                <Braces />
                <small>分块方式</small>
                <strong>{selected.chunkMethod}</strong>
              </span>
              <span>
                <BookOpen />
                <small>Agent 绑定</small>
                <strong>{selected.bindings} 个</strong>
              </span>
            </div>
          </section>

          <nav className="knowledge-tabs" aria-label="知识库详情">
            <button
              className={detailTab === "documents" ? "is-active" : ""}
              type="button"
              onClick={() => setDetailTab("documents")}
            >
              文档 <span>{resources.length}</span>
            </button>
            <button
              className={detailTab === "retrieval" ? "is-active" : ""}
              type="button"
              onClick={() => setDetailTab("retrieval")}
            >
              检索测试
            </button>
          </nav>

          {detailTab === "documents" ? (
            <section className="panel knowledge-documents">
              <header>
                <div>
                  <h3>文档资源</h3>
                  <span>上传后自动解析；同名文件会进入覆盖确认。</span>
                </div>
                <button className="button button--primary" type="button" onClick={() => notify("选择要上传的文件")}>
                  <Upload />
                  上传文件
                </button>
              </header>
              <div className="knowledge-documents__head">
                <span>文件</span>
                <span>切片</span>
                <span>状态</span>
                <span>启用</span>
                <span>更新时间</span>
                <span />
              </div>
              {resources.map((resource) => (
                <article key={resource.id}>
                  <span className="knowledge-file-icon">
                    <FileText />
                  </span>
                  <strong>{resource.name}</strong>
                  <span>{resource.chunks}</span>
                  <Status kind={statusKind(resource.status)}>{resource.status}</Status>
                  <button
                    type="button"
                    className={`knowledge-toggle ${resource.enabled ? "is-on" : ""}`}
                    aria-pressed={resource.enabled}
                    aria-label={`${resource.enabled ? "停用" : "启用"} ${resource.name}`}
                    onClick={() => toggleResource(resource.id)}
                  >
                    <i />
                  </button>
                  <time>{resource.updatedAt}</time>
                  <button
                    type="button"
                    className="knowledge-reparse"
                    onClick={() => notify(`${resource.name} 已进入重新解析队列`)}
                  >
                    <RefreshCcw />
                    重解析
                  </button>
                </article>
              ))}
            </section>
          ) : (
            <section className="panel retrieval-lab">
              <header>
                <TestTube2 />
                <div>
                  <h3>检索测试</h3>
                  <p>使用当前向量模型与解析配置，验证 Agent 能否召回期望片段。</p>
                </div>
              </header>
              <label>
                <span>测试问题</span>
                <textarea defaultValue="公共数据授权运营需要满足哪些安全要求？" />
              </label>
              <div className="retrieval-actions">
                <label>
                  <span>返回片段</span>
                  <select defaultValue="5">
                    <option>3</option>
                    <option>5</option>
                    <option>10</option>
                  </select>
                </label>
                <label>
                  <span>相似度阈值</span>
                  <input defaultValue="0.45" />
                </label>
                <button className="button button--primary" type="button" onClick={() => notify("检索测试已完成")}>
                  运行检索
                </button>
              </div>
              <div className="retrieval-results">
                <header>
                  <strong>召回结果</strong>
                  <span>3 个片段 · 148 ms</span>
                </header>
                {[
                  ["数据安全管理条例.pdf", "0.91", "授权运营单位应建立数据分类分级、访问控制与操作审计制度……"],
                  ["公共数据授权运营办法.docx", "0.84", "公共数据产品和服务应在授权范围内加工使用，不得超范围留存……"],
                  ["数字政府建设指南.pdf", "0.73", "建立覆盖采集、传输、存储、使用和销毁的数据安全管理机制……"],
                ].map(([file, score, content]) => (
                  <article key={file}>
                    <Tag tone="blue">{score}</Tag>
                    <div>
                      <strong>{file}</strong>
                      <p>{content}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>

      {createOpen && (
        <Modal
          title="创建知识库"
          onClose={() => setCreateOpen(false)}
          onConfirm={() => setCreateOpen(false)}
          confirmText="创建"
        >
          <div className="field">
            <label>名称</label>
            <input defaultValue="新的知识库" />
          </div>
          <div className="field">
            <label>向量模型</label>
            <select>
              <option>BAAI/bge-m3</option>
              <option>text-embedding-v4</option>
            </select>
          </div>
          <div className="field">
            <label>解析方式</label>
            <select>
              <option>通用解析</option>
              <option>说明书解析</option>
            </select>
          </div>
          <div className="field">
            <label>分块方式</label>
            <select>
              <option>智能分块</option>
              <option>按标题分块</option>
            </select>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast} />}
    </div>
  );
}
