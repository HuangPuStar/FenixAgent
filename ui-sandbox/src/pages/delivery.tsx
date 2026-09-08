import {
  ArrowUpRight,
  ChevronRight,
  Copy,
  Eye,
  Globe2,
  Mail,
  MessageCircle,
  type Radio,
  Rocket,
  Send,
  Settings2,
  Smartphone,
  Webhook,
} from "lucide-react";
import { useState } from "react";
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

export function SitesPage() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const sites = [
    ["fenix-docs", "docs.fenix-aos.cn", "文档站", "已发布", "2 分钟前"],
    ["agent-gallery", "agents.fenix-aos.cn", "智能体市场", "已发布", "昨天"],
    ["policy-insight", "policy-demo.pages.dev", "政策洞察", "构建中", "刚刚"],
    ["bid-review", "bid-review.internal", "投标审查", "草稿", "3 天前"],
  ].filter((site) => site.join("").includes(query));
  return (
    <div className="page-frame">
      <PageHeader title="应用部署" description="把智能体能力发布为可访问的网站或应用，并持续查看构建与运行状态。">
        <PrimaryButton onClick={() => setOpen(true)}>新建应用</PrimaryButton>
      </PageHeader>
      <SearchToolbar value={query} onChange={setQuery} placeholder="搜索应用或域名">
        <button className="button button--ghost" type="button">
          <Settings2 />
          环境
        </button>
        <ToolbarSummary>
          <span>
            <strong>{sites.length}</strong> 个应用
          </span>
        </ToolbarSummary>
      </SearchToolbar>
      <section className="site-grid">
        {sites.map((site, index) => (
          <article className="panel site-card" key={site[0]}>
            <div className={`site-preview site-preview--${index + 1}`}>
              <span>
                {index === 0 ? "Fenix Docs" : index === 1 ? "Discover Agents" : index === 2 ? "政策洞察" : "投标审查"}
              </span>
              <i />
              <i />
              <i />
            </div>
            <div className="site-card__body">
              <header>
                <span className="cell-icon">
                  <Globe2 />
                </span>
                <div>
                  <h3>{site[0]}</h3>
                  <a href={`https://${site[1]}`} onClick={(event) => event.preventDefault()}>
                    {site[1]} <ArrowUpRight />
                  </a>
                </div>
                <RowMenu />
              </header>
              <footer>
                <Status kind={site[3] === "已发布" ? "success" : site[3] === "构建中" ? "warning" : "default"}>
                  {site[3]}
                </Status>
                <span>{site[4]}</span>
                <button type="button">
                  <Rocket />
                  部署
                </button>
              </footer>
            </div>
          </article>
        ))}
      </section>
      {open && (
        <Modal title="新建应用" onClose={() => setOpen(false)}>
          <FormFields kind="应用" />
          <div className="field">
            <label>部署模板</label>
            <select>
              <option>Agent 对话应用</option>
              <option>数据看板</option>
              <option>内容站点</option>
            </select>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function ViewsPage() {
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState(false);
  const rows = [
    ["投标审查体验页", "投标文件审查", "公开链接", "128", "已发布"],
    ["公文写作内测", "公文写手", "组织内", "86", "已发布"],
    ["经营数据问答", "经营数据助手", "指定成员", "42", "已暂停"],
  ].filter((row) => row.join("").includes(query));
  return (
    <div className="page-frame">
      <PageHeader title="发布视图" description="为智能体生成面向用户的轻量交互入口，并控制品牌、访问范围与分享链接。">
        <PrimaryButton>新建视图</PrimaryButton>
      </PageHeader>
      <SearchToolbar value={query} onChange={setQuery} placeholder="搜索视图或智能体">
        <ToolbarSummary>
          <span>
            <strong>{rows.length}</strong> 个视图
          </span>
        </ToolbarSummary>
      </SearchToolbar>
      <section className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>发布视图</th>
              <th>智能体</th>
              <th>访问范围</th>
              <th>近 7 日访问</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[0]}>
                <td>
                  <div className="cell-title">
                    <span className="cell-icon">
                      <Eye />
                    </span>
                    <strong>{row[0]}</strong>
                  </div>
                </td>
                <td>{row[1]}</td>
                <td>
                  <Tag>{row[2]}</Tag>
                </td>
                <td>{row[3]}</td>
                <td>
                  <Status kind={row[4] === "已发布" ? "success" : "default"}>{row[4]}</Status>
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      title="复制链接"
                      onClick={() => {
                        setToast(true);
                        window.setTimeout(() => setToast(false), 1600);
                      }}
                    >
                      <Copy />
                    </button>
                    <RowMenu />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {toast && <Toast text="分享链接已复制（Mock）" />}
    </div>
  );
}

export function ChannelsPage() {
  const [open, setOpen] = useState(false);
  const channels = [
    ["企业微信", "研发中心 Agent 群", MessageCircle, "12 个智能体", "已连接"],
    ["飞书", "产品设计协作群", Send, "8 个智能体", "已连接"],
    ["Webhook", "CRM 事件入口", Webhook, "3 个工作流", "已连接"],
    ["邮件", "service@fenix-aos.cn", Mail, "2 个智能体", "待验证"],
    ["短信", "阿里云短信", Smartphone, "未绑定", "未配置"],
  ];
  return (
    <div className="page-frame">
      <PageHeader title="消息渠道" description="把智能体接入团队已有的沟通工具和业务事件，让对话发生在用户工作的地方。">
        <PrimaryButton onClick={() => setOpen(true)}>连接渠道</PrimaryButton>
      </PageHeader>
      <section className="channel-grid">
        {channels.map(([name, desc, Icon, binding, state]) => {
          const ChannelIcon = Icon as typeof Radio;
          return (
            <article className="panel channel-card" key={name as string}>
              <span className="channel-card__icon">
                <ChannelIcon />
              </span>
              <div>
                <h3>{name as string}</h3>
                <p>{desc as string}</p>
                <small>{binding as string}</small>
              </div>
              <Status kind={state === "已连接" ? "success" : state === "待验证" ? "warning" : "default"}>
                {state as string}
              </Status>
              <button type="button">
                <Settings2 />
              </button>
            </article>
          );
        })}
      </section>
      {open && (
        <Modal title="连接消息渠道" onClose={() => setOpen(false)}>
          <div className="channel-options">
            {[
              [MessageCircle, "企业微信"],
              [Send, "飞书"],
              [Webhook, "Webhook"],
              [Mail, "邮件"],
            ].map(([Icon, name]) => {
              const ChannelIcon = Icon as typeof Radio;
              return (
                <button type="button" key={name as string}>
                  <ChannelIcon />
                  <span>
                    <strong>{name as string}</strong>
                    <small>查看配置步骤</small>
                  </span>
                  <ChevronRight />
                </button>
              );
            })}
          </div>
        </Modal>
      )}
    </div>
  );
}
