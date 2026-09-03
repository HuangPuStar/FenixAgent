import {
  Bot,
  Braces,
  ChevronDown,
  CirclePlay,
  Clock3,
  Database,
  GitBranch,
  MoreHorizontal,
  Play,
  Plus,
  Save,
  Search,
  Settings2,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { PageHeader, PrimaryButton, SearchToolbar, Status, Tag, ToolbarSummary } from "../components/ui";

export function WorkflowPage() {
  const [mode, setMode] = useState<"list" | "editor">("list");
  const [query, setQuery] = useState("");
  if (mode === "editor") return <WorkflowEditor onBack={() => setMode("list")} />;
  const rows = [
    ["投标材料自动审查", "上传文件后分段审查并生成风险报告", "7 个节点", "12 分钟前", "已发布"],
    ["每日经营简报", "聚合业务库数据并发送到企业微信", "9 个节点", "今天 08:30", "已发布"],
    ["知识库增量维护", "定时扫描文件并同步向量知识库", "5 个节点", "昨天", "草稿"],
    ["客户问题分流", "识别意图后交给对应业务智能体", "11 个节点", "3 天前", "已暂停"],
  ];
  return (
    <div className="page-frame">
      <PageHeader title="智能体编排" description="用可视化节点连接模型、工具、数据与业务规则，构建可观测的自动化流程。">
        <PrimaryButton onClick={() => setMode("editor")}>新建工作流</PrimaryButton>
      </PageHeader>
      <SearchToolbar value={query} onChange={setQuery} placeholder="搜索工作流">
        <button className="button button--ghost" type="button">
          <Settings2 />
          状态
        </button>
        <ToolbarSummary>
          <span>
            <strong>{rows.filter((row) => row[0].includes(query)).length}</strong> 个工作流
          </span>
        </ToolbarSummary>
      </SearchToolbar>
      <section className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>工作流</th>
              <th>规模</th>
              <th>最近运行</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((row) => row[0].includes(query))
              .map((row) => (
                <tr key={row[0]}>
                  <td>
                    <button className="agent-name" type="button" onClick={() => setMode("editor")}>
                      <span className="cell-icon">
                        <WorkflowIcon />
                      </span>
                      <span className="cell-copy">
                        <strong>{row[0]}</strong>
                        <small>{row[1]}</small>
                      </span>
                    </button>
                  </td>
                  <td>{row[2]}</td>
                  <td>{row[3]}</td>
                  <td>
                    <Status kind={row[4] === "已发布" ? "success" : row[4] === "草稿" ? "warning" : "default"}>
                      {row[4]}
                    </Status>
                  </td>
                  <td>
                    <button className="kebab" type="button">
                      <MoreHorizontal />
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function WorkflowEditor({ onBack }: { onBack: () => void }) {
  return (
    <div className="workflow-editor">
      <header className="workflow-bar">
        <button className="button button--ghost" type="button" onClick={onBack}>
          ‹ 返回
        </button>
        <span>
          <strong>投标材料自动审查</strong>
          <small>草稿已自动保存</small>
        </span>
        <div className="toolbar__spacer" />
        <button className="button" type="button">
          <Save />
          保存
        </button>
        <button className="button button--primary" type="button">
          <Play />
          试运行
        </button>
      </header>
      <div className="workflow-body">
        <aside className="node-library">
          <h3>节点</h3>
          <label>
            <Search />
            <input placeholder="搜索节点" />
          </label>
          {[
            ["智能体", Bot],
            ["条件分支", GitBranch],
            ["代码", Braces],
            ["数据查询", Database],
            ["等待", Clock3],
            ["触发器", Zap],
          ].map(([label, Icon]) => {
            const NodeIcon = Icon as typeof Bot;
            return (
              <button type="button" key={label as string}>
                <NodeIcon />
                <span>{label as string}</span>
                <Plus />
              </button>
            );
          })}
        </aside>
        <section className="workflow-canvas">
          <div className="canvas-dots" />
          <div className="flow-node flow-node--start" style={{ left: "8%", top: "42%" }}>
            <span>
              <CirclePlay />
            </span>
            <div>
              <small>触发器</small>
              <strong>收到投标文件</strong>
            </div>
          </div>
          <span className="connector" style={{ left: "27%", top: "49%", width: "11%" }} />
          <div className="flow-node" style={{ left: "38%", top: "25%" }}>
            <span>
              <Bot />
            </span>
            <div>
              <small>智能体</small>
              <strong>检查文件完整性</strong>
            </div>
            <ChevronDown />
          </div>
          <span className="connector connector--down" style={{ left: "49%", top: "41%", height: "13%" }} />
          <div className="flow-node" style={{ left: "38%", top: "54%" }}>
            <span>
              <GitBranch />
            </span>
            <div>
              <small>条件分支</small>
              <strong>是否存在缺项</strong>
            </div>
            <ChevronDown />
          </div>
          <span className="connector" style={{ left: "58%", top: "62%", width: "10%" }} />
          <div className="flow-node" style={{ left: "68%", top: "54%" }}>
            <span>
              <Bot />
            </span>
            <div>
              <small>智能体</small>
              <strong>生成审查报告</strong>
            </div>
            <ChevronDown />
          </div>
        </section>
        <aside className="node-config">
          <h3>节点设置</h3>
          <div className="field">
            <label>节点名称</label>
            <input defaultValue="检查文件完整性" />
          </div>
          <div className="field">
            <label>选择智能体</label>
            <select defaultValue="bid">
              <option value="bid">投标文件审查</option>
            </select>
          </div>
          <div className="field">
            <label>输出变量</label>
            <input defaultValue="review_result" />
          </div>
          <div className="config-note">
            <Tag tone="blue">自动重试 2 次</Tag>
            <p>失败后将错误信息传递给下一节点。</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
