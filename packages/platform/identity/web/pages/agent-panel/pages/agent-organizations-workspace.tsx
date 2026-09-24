// agent-organizations-workspace.tsx
// 组织页主从工作区。页面样式原先全在 `agent-organizations.css`（513 行自定义类）里，2026-09-23 整片
// 换成下面的 Tailwind 工具类：该 CSS 与其 import 已删除，只剩同目录的 `agent-organizations-workspace.css`
// 承载 ≤900px 断点那一组声明（原因为那里的断点不是 Tailwind 标准档、且单列改造必须压过库内未分层的列定义）。
//
// **下面这套档位现在只管详情区**：左侧目录栏的取值 2026-09-23 已全部归还共享构件集
// `@fenix/ui-components/components/agent-catalog-index`（五页同一份，含字号），本页不再为目录栏写任何取值，
// 唯一保留的目录侧页面语义是行首图标的角色三态色（落在 TSX 的工具类上）。
//
// **字号档位是怎么定的**（这条结论没有随那份 CSS 消失，改字号前先读）：
// 宿主 `apps/web/src/index.css` 的 `html, body { font-size: 13px }` 让全部 rem 刻度按 13/16 渲染——
// 2026-09-23 用 dist 产物在 Chromium 读 `getComputedStyle` 实测：`text-xs` 9.75px、`text-3xs` 10px
// （px token，不随根字号缩放）、`text-sm` 11.375px、`text-base` 13px、`text-lg` 14.625px、`text-xl` 16.25px。
// 于是原 px 档落到：详情标题 20px → `text-xl`（16.25px，与 skills / knowledge 的详情标题同尺）、
// 徽标 18px 与分区标题 15px → `text-lg`、条目标题 13px → `text-base`（不变）、元信息 12px 与次要说明
// 11px → `text-sm`、微标签 10px 与机器标签 9px → `text-xs`；运行期顺序单调（16.25 > 14.625 > 13 >
// 11.375 > 9.75）。
//
// 为什么整页不用 `text-3xs`：它固定 10px，在 13px 根下反而比 `text-xs`(9.75px) 大，而本页层级依赖
// 「微标签 < 次要说明」这类相邻档，混用两者会让运行期层级反序——10px 与 9px 两档因此一并落到 `text-xs`。
//
// 已知偏差：同角色比原 px 小 0~3.75px（逐条差异见转换报告）；与仍走名义 px 的 `agent-api-keys.css` /
// `agent-sites.css` 等页面存在 13/16 的口径差，那批属另一批存量，本批未动。
import {
  AgentCatalogIndex,
  AgentCatalogIndexArrow,
  AgentCatalogIndexCopy,
  AgentCatalogIndexIcon,
  AgentCatalogIndexItem,
  AgentCatalogIndexMeta,
  AgentCatalogIndexNav,
} from "@fenix/ui-components/components/agent-catalog-index";
import {
  AgentMasterDetailHeader,
  AgentMasterDetailWorkspace,
} from "@fenix/ui-components/components/agent-master-detail-workspace";
import { copyTextToClipboard } from "@fenix/ui-components/lib/clipboard";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import {
  Check,
  Copy,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  Trash2,
  User,
  UserPlus,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { OrgMember } from "../../../api/organizations";
import { ORG_SELECT_CLASS } from "./agent-organizations-classes";
import type { MachineView, OrganizationsWorkspaceProps } from "./agent-organizations-types";
import { canOperateMachine } from "./agent-organizations-utils";
import "./agent-organizations-workspace.css";

/**
 * 目录行首的角色图标。
 *
 * 只负责**着色**——三态色是本页独有的语义，共享图标盒刻意不声明 `color`，因此这里的工具类不会被
 * 未分层的共享 CSS 压过。尺寸不在这里给：图标盒把内层 svg 统一到 16.25px（`size-4` 那类工具类
 * 写在 `@layer utilities`，即便留着也不生效，故一并移除以免误导）。
 */
function RoleIcon({ role }: { role: string }) {
  if (role === "owner") return <Shield className="text-yellow-600" />;
  if (role === "admin") return <ShieldCheck className="text-blue-500" />;
  return <User className="text-text-muted" />;
}

function RoleBadge({ role }: { role: string }) {
  const { t } = useTranslation(NS.ORGS);
  const tone = role === "owner" ? "text-yellow-700" : role === "admin" ? "text-emerald-600" : "text-text-secondary";
  return <span className={`text-xs ${tone}`}>{t(`roles.${role}`, role)}</span>;
}

/** 完整展示组织 ID，并提供明确的复制操作名称。 */
export function OrganizationIdCopy({ id, onCopy }: { id: string; onCopy: () => void }) {
  const { t } = useTranslation(NS.ORGS);
  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-1.25 border-0 bg-transparent p-0 text-left hover:text-blue-700"
      onClick={onCopy}
      aria-label={t("copyId")}
      title={t("copyId")}
    >
      <code className="wrap-anywhere text-sm">{id}</code>
      <Copy className="size-3.5 shrink-0" />
    </button>
  );
}

function OrganizationDirectory({ props }: { props: OrganizationsWorkspaceProps }) {
  const { t } = useTranslation(NS.ORGS);
  // 目录栏外观（内边距 / 底色 / 分隔线 / 头部 / 行距 / 条目三态 / 图标盒 / 字号）全在共享构件集的伴生 CSS。
  // 本页此前那三处高特异性覆盖（首列宽 `1rem`、大写字距、计数退回纯文字）已随本版删除：它们存在的
  // 理由是「本页转入了 13/16 rem 刻度，与共享的 px 刻度不同」，而共享默认值现在本身就是 rem 刻度
  // （见 `agent-catalog-index.css` 文件头），层级单调由共享那一套档位保证，不再需要页面纠偏。
  // 本页保留的只有：行首图标的**角色三态色**（着色语义，图标盒刻意不声明 `color`），以及 ≤900px 的
  // 单列 + 目录横置那一组声明（非标准断点 + 必须压过库内未分层的列定义，见伴生 CSS）。
  // 随骨架而来、**不是**「原样」的两处语义变化：目录列表由 `<div>` 变成 `<nav aria-label>`（多一个地标，
  // 名字复用 `t("myOrgs")`），选中行多出 `aria-current="page"`（此前选中只体现在配色上）。
  return (
    <AgentCatalogIndex
      // `org-directory` 不再承载任何外观，只作 ≤900px 那条布局规则的挂载点（见伴生 CSS）。
      className="org-directory"
      label={t("myOrgs")}
      title={t("myOrgs")}
      count={props.organizations.length}
    >
      {/* `gap-1` 那类工具类在这里不再需要：行距由共享 CSS 的 `.agent-catalog-index-nav` 统一给，
          工具类位于 `@layer utilities`、会被未分层声明整条压过。`org-directory-list` 只作窄屏那条
          `min-width` 规则的挂载点。 */}
      <AgentCatalogIndexNav className="org-directory-list" label={t("myOrgs")} stripOnNarrow="900px">
        {props.organizations.map((organization) => {
          const selected = organization.id === props.selectedOrgId;
          return (
            <AgentCatalogIndexItem
              key={organization.id}
              selected={selected}
              // `org-directory-row` 不承载外观，只作窄屏行宽规则的挂载点（见伴生 CSS）。
              className="org-directory-row"
              onClick={() => props.onSelectOrg(organization.id)}
            >
              <AgentCatalogIndexIcon>
                <RoleIcon role={organization.role} />
              </AgentCatalogIndexIcon>
              <AgentCatalogIndexCopy title={organization.name} subtitle={organization.slug} />
              <AgentCatalogIndexMeta>
                <span>{t(`roles.${organization.role}`, organization.role)}</span>
              </AgentCatalogIndexMeta>
              <AgentCatalogIndexArrow />
            </AgentCatalogIndexItem>
          );
        })}
        {props.organizations.length === 0 ? (
          <p className="px-2.5 py-7.5 text-center text-sm text-text-muted">{t("noOrgs")}</p>
        ) : null}
      </AgentCatalogIndexNav>
    </AgentCatalogIndex>
  );
}

function MembersSection({ props }: { props: OrganizationsWorkspaceProps }) {
  const { t } = useTranslation(NS.ORGS);
  return (
    <section className="pt-7">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <span className="text-xs font-bold tracking-widest text-blue-700 uppercase">{t("workspace.people")}</span>
          <h3 className="mt-0.5 text-lg text-slate-800">{t("members", { count: props.members.length })}</h3>
        </div>
        {props.canManage ? (
          <Button size="sm" variant="ghost" onClick={props.onOpenInvite}>
            <UserPlus className="size-4" />
            {t("inviteMember")}
          </Button>
        ) : null}
      </div>
      <div className="border-t border-slate-100" role="list">
        {props.members.map((member: OrgMember) => (
          <div
            className="group flex min-h-16.5 items-center gap-3 border-b border-slate-100 px-1.5 py-2.5"
            role="listitem"
            key={member.id}
          >
            <div className="grid size-8.5 flex-none place-items-center rounded-full bg-surface-hover text-sm font-bold text-blue-700">
              {(member.user?.name || member.userId).slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <strong className="truncate text-base text-text-primary">{member.user?.name || member.userId}</strong>
                <RoleBadge role={member.role} />
              </div>
              <span className="mt-0.75 block truncate text-sm text-text-muted">
                {member.user?.email || member.user?.phoneNumber || "-"}
              </span>
            </div>
            <div className="flex items-center gap-0.5 opacity-20 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              {props.isOwner && member.role !== "owner" ? (
                <select
                  className={ORG_SELECT_CLASS}
                  value={member.role}
                  onChange={(event) => props.onUpdateRole(member.id, event.target.value)}
                >
                  <option value="admin">{t("roles.admin")}</option>
                  <option value="member">{t("roles.member")}</option>
                </select>
              ) : null}
              {props.canManage && member.role !== "owner" ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => props.onRemoveMember(member)}
                  aria-label={t("removeMemberDialog.title")}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </div>
          </div>
        ))}
        {props.members.length === 0 ? (
          <p className="px-2.5 py-7.5 text-center text-sm text-text-muted">{t("noMembers")}</p>
        ) : null}
      </div>
    </section>
  );
}

function MachineRow({ machine, props }: { machine: MachineView; props: OrganizationsWorkspaceProps }) {
  const { t } = useTranslation(NS.ORGS);
  const hostname = (machine.machineInfo?.hostname as string | undefined) ?? machine.agentName;
  const canOperate = canOperateMachine(machine, props.selectedOrgId, props.currentUserId, props.canManage);
  return (
    <div className="group flex min-h-16.5 items-center gap-3 border-b border-slate-100 px-1.5 py-2.5" role="listitem">
      <div
        className={`grid size-8.5 flex-none place-items-center rounded-md ${
          machine.status === "online" ? "bg-emerald-50 text-emerald-600" : "bg-surface-2 text-text-muted"
        }`}
      >
        <Monitor className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong className="truncate text-base text-text-primary">{machine.name ?? hostname}</strong>
          <span className={`text-xs ${machine.status === "online" ? "text-emerald-600" : "text-text-secondary"}`}>
            {t(`machineStatus.${machine.status === "online" ? "online" : "offline"}`)}
          </span>
        </div>
        <span className="mt-0.75 block truncate text-sm text-text-muted">
          {hostname} · {machine.agentName} · {machine.id.slice(0, 8)}
        </span>
      </div>
      <div className="flex gap-1">
        {(machine.labels ?? [])
          .filter((label) => label !== "remote-runtime")
          .slice(0, 2)
          .map((label) => (
            <span key={label} className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted">
              {label}
            </span>
          ))}
      </div>
      <div className="flex items-center gap-0.5 opacity-20 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("copyId")}
          onClick={() =>
            void copyTextToClipboard(machine.id).then((ok) =>
              ok ? toast.success(t("copied")) : toast.error(t("copyFailed")),
            )
          }
        >
          <Copy className="size-4" />
        </Button>
        {canOperate ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label={t("edit")} onClick={() => props.onEditMachine(machine)}>
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("deleteMachineDialog.title")}
              onClick={() => props.onDeleteMachine(machine)}
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function MachinesSection({ props }: { props: OrganizationsWorkspaceProps }) {
  const { t } = useTranslation(NS.ORGS);
  return (
    <section className="mt-6.5 border-t border-slate-100 pt-7">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <span className="text-xs font-bold tracking-widest text-blue-700 uppercase">{t("workspace.runtime")}</span>
          <h3 className="mt-0.5 text-lg text-slate-800">{t("machines", { count: props.machines.length })}</h3>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={props.onRefreshMachines} disabled={props.machinesLoading}>
            <RefreshCw className={`size-4${props.machinesLoading ? " animate-spin" : ""}`} />
            {t("machineRefresh")}
          </Button>
          {props.canManage ? (
            <Button size="sm" variant="ghost" onClick={props.onOpenCreateMachine}>
              <Plus className="size-4" />
              {t("addMachine")}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="border-t border-slate-100" role="list">
        {props.machines.map((machine) => (
          <MachineRow key={machine.id} machine={machine} props={props} />
        ))}
        {props.machines.length === 0 && !props.machinesLoading ? (
          <p className="px-2.5 py-7.5 text-center text-sm text-text-muted">{t("noMachines")}</p>
        ) : null}
      </div>
    </section>
  );
}

function OrganizationDetail({
  props,
  headerOnly = false,
}: {
  props: OrganizationsWorkspaceProps;
  headerOnly?: boolean;
}) {
  const { t } = useTranslation(NS.ORGS);
  if (props.detailLoading)
    return (
      <div className="grid gap-3.5 p-8.5">
        {[1, 2, 3].map((item) => (
          <Skeleton key={item} className="h-20 w-full" />
        ))}
      </div>
    );
  if (!props.detail)
    return (
      <div className="grid min-h-130 place-content-center justify-items-center text-base text-text-muted">
        <Shield className="size-7" />
        <p>{t("selectOrg")}</p>
      </div>
    );
  const header = (
    <AgentMasterDetailHeader className="flex min-h-26 items-center justify-between gap-6 border-b border-slate-200 px-7 py-5">
      <div className="flex min-w-0 items-center gap-3.5">
        <div className="grid size-11.5 flex-none place-items-center rounded-lg bg-surface-hover text-lg font-bold text-blue-700">
          {props.detail.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          {props.editingName ? (
            <div className="flex items-center gap-1.5">
              <Input
                className="w-full max-w-80"
                value={props.editName}
                onChange={(event) => props.onEditNameChange(event.target.value)}
              />
              <Button size="sm" onClick={props.onSaveName} disabled={props.updateNameLoading}>
                <Check className="size-4" />
                {t("save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={props.onCancelEditName}>
                {t("cancel")}
              </Button>
            </div>
          ) : (
            <h2 className="text-xl leading-tight font-bold text-slate-800">{props.detail.name}</h2>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm text-text-muted">
            <span>{props.detail.slug}</span>
            <OrganizationIdCopy id={props.detail.id} onCopy={props.onCopyId} />
          </div>
        </div>
      </div>
      {props.canManage && !props.editingName ? (
        <Button size="sm" variant="ghost" onClick={props.onStartEditName}>
          <Pencil className="size-4" />
          {t("edit")}
        </Button>
      ) : null}
    </AgentMasterDetailHeader>
  );
  if (headerOnly) return header;
  return (
    <div className="org-detail min-w-0 px-7 pt-6 pb-8">
      {props.isOwner ? (
        <div className="org-engine-strip flex min-h-17 items-center justify-between gap-5 rounded-md bg-surface-0 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Monitor className="size-4" />
            <span>
              <strong className="block text-sm text-text-primary">{t("defaultEngine")}</strong>
              <small className="mt-0.5 block text-sm text-text-muted">{t("workspace.engineDescription")}</small>
            </span>
          </div>
          <select
            className={ORG_SELECT_CLASS}
            value={props.defaultMachineId}
            onChange={(event) => props.onDefaultMachineChange(event.target.value)}
          >
            <option value="local">{t("form.machineLocal")}</option>
            {props.machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.name || machine.agentName} ·{" "}
                {t(`machineStatus.${machine.status === "online" ? "online" : "offline"}`)}
              </option>
            ))}
          </select>
          {props.engineDirty ? (
            <div className="flex items-center">
              <Button size="sm" onClick={props.onSaveDefaultEngine} disabled={props.savingEngine}>
                {t("save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={props.onCancelDefaultEngine}>
                {t("cancel")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <MembersSection props={props} />
      <MachinesSection props={props} />
      {props.isOwner ? (
        <section className="mt-8 flex items-center justify-between gap-4.5 border-t border-red-100 pt-4.5">
          <div>
            <strong className="block text-sm text-destructive">{t("dangerZone.title")}</strong>
            <span className="mt-0.75 block text-sm text-text-muted">{t("dangerZone.description")}</span>
          </div>
          <Button variant="ghost" onClick={props.onDeleteOrganization} disabled={props.organizations.length <= 1}>
            <Trash2 className="size-4" />
            {t("dangerZone.deleteOrg")}
          </Button>
        </section>
      ) : null}
    </div>
  );
}

export function OrganizationsWorkspace(props: OrganizationsWorkspaceProps) {
  return (
    <AgentMasterDetailWorkspace
      className="org-workspace mt-6 border border-slate-200"
      index={<OrganizationDirectory props={props} />}
      detailHeader={props.detail ? <OrganizationDetail props={props} headerOnly /> : null}
    >
      <OrganizationDetail props={props} />
    </AgentMasterDetailWorkspace>
  );
}
