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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { OrgMember } from "@/src/api/organizations";
import type { MachineRecord } from "@/src/api/registry";
import { AgentMasterDetailHeader, AgentMasterDetailWorkspace } from "../shared/agent-master-detail-workspace";
import type { OrganizationsWorkspaceProps } from "./agent-organizations-types";
import { canOperateMachine } from "./agent-organizations-utils";

function RoleIcon({ role }: { role: string }) {
  if (role === "owner") return <Shield className="org-role-icon is-owner" />;
  if (role === "admin") return <ShieldCheck className="org-role-icon is-admin" />;
  return <User className="org-role-icon" />;
}

function RoleBadge({ role }: { role: string }) {
  const { t } = useTranslation("orgs");
  return <span className={`org-role-badge is-${role}`}>{t(`roles.${role}`, role)}</span>;
}

/** 完整展示组织 ID，并提供明确的复制操作名称。 */
export function OrganizationIdCopy({ id, onCopy }: { id: string; onCopy: () => void }) {
  const { t } = useTranslation("orgs");
  return (
    <button type="button" onClick={onCopy} aria-label={t("copyId")} title={t("copyId")}>
      <code>{id}</code>
      <Copy className="size-3.5" />
    </button>
  );
}

function OrganizationDirectory({ props }: { props: OrganizationsWorkspaceProps }) {
  const { t } = useTranslation("orgs");
  return (
    <aside className="org-directory" aria-label={t("myOrgs")}>
      <div className="org-directory-heading">
        <span>{t("myOrgs")}</span>
        <span>{props.organizations.length}</span>
      </div>
      <div className="org-directory-list">
        {props.organizations.map((organization) => (
          <button
            key={organization.id}
            type="button"
            className={`org-directory-row${organization.id === props.selectedOrgId ? " is-active" : ""}`}
            onClick={() => props.onSelectOrg(organization.id)}
          >
            <RoleIcon role={organization.role} />
            <span className="org-directory-copy">
              <strong>{organization.name}</strong>
              <small>{organization.slug}</small>
            </span>
            <span className="org-directory-role">{t(`roles.${organization.role}`, organization.role)}</span>
          </button>
        ))}
        {props.organizations.length === 0 ? <p className="org-empty-copy">{t("noOrgs")}</p> : null}
      </div>
    </aside>
  );
}

function MembersSection({ props }: { props: OrganizationsWorkspaceProps }) {
  const { t } = useTranslation("orgs");
  return (
    <section className="org-section">
      <div className="org-section-heading">
        <div>
          <span className="org-section-kicker">{t("workspace.people")}</span>
          <h3>{t("members", { count: props.members.length })}</h3>
        </div>
        {props.canManage ? (
          <Button size="sm" variant="ghost" onClick={props.onOpenInvite}>
            <UserPlus className="size-4" />
            {t("inviteMember")}
          </Button>
        ) : null}
      </div>
      <div className="org-list" role="list">
        {props.members.map((member: OrgMember) => (
          <div className="org-list-row" role="listitem" key={member.id}>
            <div className="org-person-avatar">{(member.user?.name || member.userId).slice(0, 1).toUpperCase()}</div>
            <div className="org-list-main">
              <div className="org-list-title">
                <strong>{member.user?.name || member.userId}</strong>
                <RoleBadge role={member.role} />
              </div>
              <span>{member.user?.email || member.user?.phoneNumber || "-"}</span>
            </div>
            <div className="org-list-actions">
              {props.isOwner && member.role !== "owner" ? (
                <select value={member.role} onChange={(event) => props.onUpdateRole(member.id, event.target.value)}>
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
        {props.members.length === 0 ? <p className="org-empty-copy">{t("noMembers")}</p> : null}
      </div>
    </section>
  );
}

function MachineRow({ machine, props }: { machine: MachineRecord; props: OrganizationsWorkspaceProps }) {
  const { t } = useTranslation("orgs");
  const hostname = (machine.machineInfo?.hostname as string | undefined) ?? machine.agentName;
  const canOperate = canOperateMachine(machine, props.selectedOrgId, props.currentUserId, props.canManage);
  return (
    <div className="org-list-row" role="listitem">
      <div className={`org-machine-state${machine.status === "online" ? " is-online" : ""}`}>
        <Monitor className="size-4" />
      </div>
      <div className="org-list-main">
        <div className="org-list-title">
          <strong>{machine.name ?? hostname}</strong>
          <span className={`org-status${machine.status === "online" ? " is-online" : ""}`}>
            {t(`machineStatus.${machine.status === "online" ? "online" : "offline"}`)}
          </span>
        </div>
        <span>
          {hostname} · {machine.agentName} · {machine.id.slice(0, 8)}
        </span>
      </div>
      <div className="org-machine-labels">
        {(machine.labels ?? [])
          .filter((label) => label !== "remote-runtime")
          .slice(0, 2)
          .map((label) => (
            <span key={label}>{label}</span>
          ))}
      </div>
      <div className="org-list-actions">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("copyId")}
          onClick={() => {
            navigator.clipboard.writeText(machine.id);
            toast.success(t("copied"));
          }}
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
  const { t } = useTranslation("orgs");
  return (
    <section className="org-section">
      <div className="org-section-heading">
        <div>
          <span className="org-section-kicker">{t("workspace.runtime")}</span>
          <h3>{t("machines", { count: props.machines.length })}</h3>
        </div>
        <div className="org-section-actions">
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
      <div className="org-list" role="list">
        {props.machines.map((machine) => (
          <MachineRow key={machine.id} machine={machine} props={props} />
        ))}
        {props.machines.length === 0 && !props.machinesLoading ? (
          <p className="org-empty-copy">{t("noMachines")}</p>
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
  const { t } = useTranslation("orgs");
  if (props.detailLoading)
    return (
      <div className="org-detail-loading">
        {[1, 2, 3].map((item) => (
          <Skeleton key={item} className="h-20 w-full" />
        ))}
      </div>
    );
  if (!props.detail)
    return (
      <div className="org-detail-empty">
        <Shield className="size-7" />
        <p>{t("selectOrg")}</p>
      </div>
    );
  const header = (
    <AgentMasterDetailHeader className="org-detail-header">
      <div className="org-detail-identity">
        <div className="org-detail-mark">{props.detail.name.slice(0, 1).toUpperCase()}</div>
        <div>
          {props.editingName ? (
            <div className="org-name-editor">
              <Input value={props.editName} onChange={(event) => props.onEditNameChange(event.target.value)} />
              <Button size="sm" onClick={props.onSaveName} disabled={props.updateNameLoading}>
                <Check className="size-4" />
                {t("save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={props.onCancelEditName}>
                {t("cancel")}
              </Button>
            </div>
          ) : (
            <h2>{props.detail.name}</h2>
          )}
          <div className="org-detail-meta">
            <span>{props.detail.slug}</span>
            <OrganizationIdCopy id={props.detail.id} onCopy={props.onCopyId} />
            {props.copiedId ? <em>{t("copied")}</em> : null}
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
    <div className="org-detail">
      {props.isOwner ? (
        <div className="org-engine-strip">
          <div>
            <Monitor className="size-4" />
            <span>
              <strong>{t("defaultEngine")}</strong>
              <small>{t("workspace.engineDescription")}</small>
            </span>
          </div>
          <select value={props.defaultMachineId} onChange={(event) => props.onDefaultMachineChange(event.target.value)}>
            <option value="local">{t("form.machineLocal")}</option>
            {props.machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.name || machine.agentName} ·{" "}
                {t(`machineStatus.${machine.status === "online" ? "online" : "offline"}`)}
              </option>
            ))}
          </select>
          {props.engineDirty ? (
            <div className="org-engine-actions">
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
        <section className="org-danger-zone">
          <div>
            <strong>{t("dangerZone.title")}</strong>
            <span>{t("dangerZone.description")}</span>
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
      className="org-workspace"
      index={<OrganizationDirectory props={props} />}
      detailHeader={props.detail ? <OrganizationDetail props={props} headerOnly /> : null}
    >
      <OrganizationDetail props={props} />
    </AgentMasterDetailWorkspace>
  );
}
