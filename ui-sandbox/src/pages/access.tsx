import {
  Building2,
  Check,
  Copy,
  KeyRound,
  Monitor,
  Pencil,
  Server,
  Shield,
  Trash2,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useState } from "react";
import { Modal, PageHeader, PrimaryButton, SearchToolbar, Status, Tag, Toast, ToolbarSummary } from "../components/ui";

const ORGANIZATIONS = [
  { id: "org_phoenix_01", name: "凤凰科技", slug: "phoenix-technology", role: "所有者", members: 4 },
  { id: "org_lab_02", name: "智能应用实验室", slug: "agent-lab", role: "管理员", members: 7 },
];

const MEMBERS = [
  { name: "Pu Wang", email: "pu.wang@fenix.cn", phone: "138 **** 2201", role: "所有者" },
  { name: "Lin Chen", email: "lin.chen@fenix.cn", phone: "186 **** 7490", role: "管理员" },
  { name: "Mei Zhao", email: "mei.zhao@fenix.cn", phone: "—", role: "成员" },
  { name: "Tao Li", email: "tao.li@fenix.cn", phone: "139 **** 6612", role: "成员" },
];

const MACHINES = [
  {
    id: "mac_31d8f21a",
    name: "设计工作站",
    agent: "opencode",
    host: "pu-mac-studio",
    status: "在线",
    labels: ["design", "local"],
  },
  {
    id: "mac_0a7c22be",
    name: "研发构建节点",
    agent: "claude-code",
    host: "build-02",
    status: "在线",
    labels: ["build"],
  },
  { id: "mac_8e6b2c09", name: "离线备用节点", agent: "opencode", host: "spare-01", status: "离线", labels: ["backup"] },
];

export function OrganizationsPage() {
  const [selectedOrgId, setSelectedOrgId] = useState(ORGANIZATIONS[0].id);
  const [section, setSection] = useState<"members" | "machines">("members");
  const [dialog, setDialog] = useState<"create" | "invite" | null>(null);
  const [defaultMachine, setDefaultMachine] = useState("mac_31d8f21a");
  const [toast, setToast] = useState("");
  const selectedOrg = ORGANIZATIONS.find((org) => org.id === selectedOrgId) ?? ORGANIZATIONS[0];

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 1800);
  };

  return (
    <div className="page-frame access-page">
      <PageHeader title="组织" description="管理组织成员、角色与执行机器，并为 Agent 选择默认运行节点。">
        <PrimaryButton onClick={() => setDialog("create")}>创建组织</PrimaryButton>
      </PageHeader>

      <div className="org-workspace">
        <aside className="panel org-directory">
          <header>
            <span>我的组织</span>
            <strong>{ORGANIZATIONS.length}</strong>
          </header>
          {ORGANIZATIONS.map((org) => (
            <button
              type="button"
              className={org.id === selectedOrgId ? "is-active" : ""}
              onClick={() => setSelectedOrgId(org.id)}
              key={org.id}
            >
              <span className="org-directory__mark">{org.name.slice(0, 1)}</span>
              <span>
                <strong>{org.name}</strong>
                <small>{org.slug}</small>
              </span>
              <Tag tone={org.role === "所有者" ? "blue" : undefined}>{org.role}</Tag>
            </button>
          ))}
        </aside>

        <section className="panel org-detail">
          <header className="org-detail__header">
            <div className="org-detail__identity">
              <span>
                <Building2 />
              </span>
              <div>
                <h3>{selectedOrg.name}</h3>
                <p>{selectedOrg.slug}</p>
              </div>
            </div>
            <div className="org-detail__actions">
              <button className="button" type="button" onClick={() => notify("组织 ID 已复制")}>
                <Copy />
                复制 ID
              </button>
              <button className="button" type="button" onClick={() => notify("可在这里编辑组织名称")}>
                <Pencil />
                编辑名称
              </button>
            </div>
          </header>

          <div className="org-engine">
            <span className="org-engine__icon">
              <Server />
            </span>
            <div>
              <strong>默认执行节点</strong>
              <small>新建 Agent 会优先使用此节点；不可用时由运行时返回明确错误。</small>
            </div>
            <select value={defaultMachine} onChange={(event) => setDefaultMachine(event.target.value)}>
              <option value="local">本地执行</option>
              {MACHINES.map((machine) => (
                <option value={machine.id} key={machine.id}>
                  {machine.name} · {machine.status}
                </option>
              ))}
            </select>
            <button className="button button--primary" type="button" onClick={() => notify("默认执行节点已保存")}>
              保存
            </button>
          </div>

          <div className="org-section-nav">
            <button
              className={section === "members" ? "is-active" : ""}
              type="button"
              onClick={() => setSection("members")}
            >
              <Users />
              成员 <span>{MEMBERS.length}</span>
            </button>
            <button
              className={section === "machines" ? "is-active" : ""}
              type="button"
              onClick={() => setSection("machines")}
            >
              <Monitor />
              执行机器 <span>{MACHINES.length}</span>
            </button>
            <div />
            <button
              className="org-section-nav__add"
              type="button"
              onClick={() => setDialog(section === "members" ? "invite" : "create")}
            >
              {section === "members" ? <UserPlus /> : <Monitor />}
              {section === "members" ? "添加成员" : "新增机器"}
            </button>
          </div>

          {section === "members" ? (
            <div className="org-member-list">
              {MEMBERS.map((member) => (
                <article key={member.email}>
                  <span className="org-avatar">{member.name.slice(0, 1)}</span>
                  <div>
                    <strong>{member.name}</strong>
                    <small>
                      {member.email} · {member.phone}
                    </small>
                  </div>
                  <span
                    className={`org-role is-${member.role === "所有者" ? "owner" : member.role === "管理员" ? "admin" : "member"}`}
                  >
                    <Shield />
                    {member.role}
                  </span>
                  {member.role !== "所有者" && (
                    <button type="button" aria-label={`移除 ${member.name}`}>
                      <Trash2 />
                    </button>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="org-machine-list">
              {MACHINES.map((machine) => (
                <article key={machine.id}>
                  <span className={`machine-state ${machine.status === "在线" ? "is-online" : ""}`}>
                    {machine.status === "在线" ? <Wifi /> : <WifiOff />}
                  </span>
                  <div>
                    <strong>{machine.name}</strong>
                    <small>
                      {machine.host} · {machine.agent} · {machine.id}
                    </small>
                  </div>
                  <div className="machine-labels">
                    {machine.labels.map((label) => (
                      <Tag key={label}>{label}</Tag>
                    ))}
                  </div>
                  <Status kind={machine.status === "在线" ? "success" : "default"}>{machine.status}</Status>
                  <button type="button" aria-label={`编辑 ${machine.name}`}>
                    <Pencil />
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      {dialog === "create" && (
        <Modal title="创建组织" onClose={() => setDialog(null)} onConfirm={() => setDialog(null)} confirmText="创建">
          <div className="field">
            <label>组织名称</label>
            <input defaultValue="新的组织" />
          </div>
          <div className="field">
            <label>组织标识</label>
            <input defaultValue="new-organization" />
          </div>
        </Modal>
      )}
      {dialog === "invite" && (
        <Modal
          title="添加组织成员"
          onClose={() => setDialog(null)}
          onConfirm={() => setDialog(null)}
          confirmText="添加成员"
        >
          <div className="field">
            <label>搜索用户</label>
            <input placeholder="输入姓名、邮箱或手机号（至少 3 个字符）" />
          </div>
          <div className="field">
            <label>角色</label>
            <select>
              <option>成员</option>
              <option>管理员</option>
            </select>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast} />}
    </div>
  );
}

interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string;
}

const API_KEYS: ApiKeyRecord[] = [
  { id: "key_prod", name: "生产环境服务", prefix: "rcs_live_4k9a", createdAt: "2026-08-12", expiresAt: "永不过期" },
  { id: "key_data", name: "数据分析脚本", prefix: "rcs_live_8m2c", createdAt: "2026-07-28", expiresAt: "2026-10-28" },
  { id: "key_ci", name: "CI 自动化", prefix: "rcs_test_1p7x", createdAt: "2026-06-14", expiresAt: "2026-09-14" },
];

export function ApiKeysPage() {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [query, setQuery] = useState("");
  const keys = API_KEYS.filter((key) => key.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="page-frame access-page">
      <PageHeader title="API Key" description="创建用于程序化访问的密钥；完整密钥仅在创建成功时展示一次。">
        <PrimaryButton onClick={() => setOpen(true)}>创建 API Key</PrimaryButton>
      </PageHeader>
      <section className="api-security-note">
        <KeyRound />
        <div>
          <strong>密钥安全</strong>
          <p>列表只保存名称与前缀。密钥泄露后请直接撤销并重新创建，无法找回原值。</p>
        </div>
      </section>
      <SearchToolbar value={query} onChange={setQuery} placeholder="搜索 API Key 名称" className="api-toolbar">
        <ToolbarSummary>
          <span>
            <strong>{keys.length}</strong> 个密钥
          </span>
        </ToolbarSummary>
      </SearchToolbar>
      <section className="panel api-key-list">
        <header>
          <span />
          <span>名称</span>
          <span>密钥前缀</span>
          <span>创建时间</span>
          <span>过期时间</span>
          <span />
        </header>
        {keys.map((key) => (
          <article key={key.id}>
            <span className="api-key-icon">
              <KeyRound />
            </span>
            <strong>{key.name}</strong>
            <code>{key.prefix}••••••••</code>
            <time>{key.createdAt}</time>
            <span>{key.expiresAt}</span>
            <button type="button">撤销</button>
          </article>
        ))}
        {keys.length === 0 && <div className="api-key-empty">没有匹配的 API Key</div>}
      </section>

      {open && (
        <Modal
          title={revealed ? "保存 API Key" : "创建 API Key"}
          onClose={() => {
            setOpen(false);
            setRevealed(false);
          }}
          confirmText={revealed ? "我已保存" : "创建"}
          onConfirm={() => {
            if (revealed) {
              setOpen(false);
              setRevealed(false);
              return;
            }
            setRevealed(true);
          }}
        >
          {revealed ? (
            <div className="key-reveal">
              <Check />
              <strong>API Key 已创建</strong>
              <p>请立即复制并安全保存，关闭后无法再次查看。</p>
              <code>rcs_live_sk_83kd7n2px4m9</code>
              <button className="button" type="button">
                <Copy />
                复制
              </button>
            </div>
          ) : (
            <div className="field">
              <label>名称</label>
              <input defaultValue="新的 API Key" />
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
