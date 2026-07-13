import { useRequest } from "ahooks";
import { Copy, Monitor, Plus, RefreshCw, Shield, ShieldCheck, Trash2, User, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { orgApi } from "@/src/api/organizations";
import { type MachineRecord, registryApi } from "@/src/api/registry";
import { unwrap } from "@/src/api/request";
import { useOrg } from "../../../contexts/OrgContext";
import { AgentPageHeader } from "../shared/AgentPageHeader";

interface OrgMember {
  id: string;
  userId: string;
  role: string;
  user: { id: string; name: string; email: string; phoneNumber?: string | null; image?: string };
}

function RoleBadge({ role }: { role: string }) {
  const { t } = useTranslation("orgs");
  const variant = role === "owner" ? "default" : role === "admin" ? "secondary" : "outline";
  return <Badge variant={variant}>{t(`roles.${role}`, role)}</Badge>;
}

function RoleIcon({ role }: { role: string }) {
  if (role === "owner") return <Shield className="w-3.5 h-3.5 text-yellow-500" />;
  if (role === "admin") return <ShieldCheck className="w-3.5 h-3.5 text-blue-500" />;
  return <User className="w-3.5 h-3.5 text-text-dim" />;
}

function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function AgentOrganizationsPage() {
  const { t } = useTranslation("orgs");
  const { org: currentOrg, refreshOrgs } = useOrg();

  // 默认引擎设置
  const [defaultEngineType, setDefaultEngineType] = useState<string>("");
  const [defaultMachineId, setDefaultMachineId] = useState<string>("local");
  const [engineDirty, setEngineDirty] = useState(false);
  const [savingEngine, setSavingEngine] = useState(false);

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [formDesc, setFormDesc] = useState("");

  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [addMemberEmail, setAddMemberEmail] = useState("");
  const [addMemberRole, setAddMemberRole] = useState("member");

  const [deleteOpen, setDeleteOpen] = useState(false);
  // 待移除的成员：非空即打开二次确认弹窗，避免误删
  const [removeMemberTarget, setRemoveMemberTarget] = useState<OrgMember | null>(null);

  const [copiedId, setCopiedId] = useState(false);

  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState("");

  // 新增机器弹窗
  const [machineCreateOpen, setMachineCreateOpen] = useState(false);
  const [machineFormName, setMachineFormName] = useState("");
  const [machineFormLabels, setMachineFormLabels] = useState("");
  const [machineFormAgentName, setMachineFormAgentName] = useState("opencode");
  const [machineCreateResult, setMachineCreateResult] = useState<{
    id: string;
    name: string;
    initCommand: string;
  } | null>(null);

  // 组织列表
  const { data: myOrgsRaw = [], refresh: reloadOrgs } = useRequest(() => unwrap(orgApi.list()), {
    onError: (err) => {
      console.error(err);
    },
  });
  const myOrgs = myOrgsRaw as unknown as { id: string; name: string; slug: string; role: string }[];

  // 组织详情（跟随选中变化）
  const {
    data: detail,
    loading: detailLoading,
    refresh: refreshDetail,
  } = useRequest(() => unwrap(orgApi.get(selectedOrgId!)), { ready: !!selectedOrgId, refreshDeps: [selectedOrgId] });

  // 机器列表（跟随选中组织变化）
  const {
    data: machinesResponse,
    loading: machinesLoading,
    refresh: refreshMachines,
  } = useRequest(() => unwrap(registryApi.list({ limit: 50 })), {
    ready: !!selectedOrgId,
    refreshDeps: [selectedOrgId],
  });
  const machines = machinesResponse?.items ?? [];

  // 新增机器
  const { run: runCreateMachine, loading: createMachineLoading } = useRequest(
    (name: string, labels: string[], agentName: string) => unwrap(registryApi.create({ name, labels, agentName })),
    {
      manual: true,
      onSuccess: (data) => {
        setMachineCreateResult({ id: data.id, name: data.name, initCommand: data.initCommand });
        refreshMachines();
      },
      onError: (err) => {
        console.error(err);
        toast.error(t("toast.machineCreateFailed"));
      },
    },
  );

  // 首次加载时自动选中当前活跃组织
  useEffect(() => {
    if (!selectedOrgId && currentOrg?.id) {
      setSelectedOrgId(currentOrg.id);
    }
  }, [selectedOrgId, currentOrg]);

  const selectedOrgRole = myOrgs.find((o) => o.id === selectedOrgId)?.role;
  const canManage = selectedOrgRole === "owner" || selectedOrgRole === "admin";
  const isOwner = selectedOrgRole === "owner";

  useEffect(() => {
    if (!detail) return;
    const metadata = (detail as unknown as Record<string, unknown>).metadata as
      | { defaultEngine?: { engineType?: string; machineId?: string } }
      | null
      | undefined;
    const def = metadata?.defaultEngine;
    setDefaultEngineType(def?.engineType ?? "");
    setDefaultMachineId(def?.machineId || "local");
    setEngineDirty(false);
  }, [detail]);

  const handleCopyId = useCallback(() => {
    if (!selectedOrgId) return;
    navigator.clipboard.writeText(selectedOrgId);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  }, [selectedOrgId]);

  // 创建组织
  const { run: runCreate, loading: createLoading } = useRequest(
    async (name: string, slug: string) => unwrap(orgApi.create({ name: name.trim(), slug: slug || nameToSlug(name) })),
    {
      manual: true,
      onSuccess: (data) => {
        toast.success(t("toast.createSuccess"));
        setCreateOpen(false);
        setFormName("");
        setFormSlug("");
        setFormDesc("");
        reloadOrgs();
        refreshOrgs();
        setSelectedOrgId(data.id);
      },
      onError: (err) => {
        console.error(err);
        toast.error(t("toast.createFailed"));
      },
    },
  );

  // 更新组织名称（静默操作）
  const { run: runUpdateName, loading: updateNameLoading } = useRequest(
    (name: string) => unwrap(orgApi.update(selectedOrgId!, { name: name.trim() })),
    {
      manual: true,
      onSuccess: () => {
        setEditingName(false);
        refreshDetail();
        reloadOrgs();
        refreshOrgs();
      },
      onError: (err) => {
        console.error(err);
        toast.error(t("toast.updateFailed"));
      },
    },
  );

  // 添加成员
  const { run: runAddMember, loading: addMemberLoading } = useRequest(
    (identifier: string, role: string) =>
      unwrap(orgApi.addMember(selectedOrgId!, { identifier: identifier.trim(), role })),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("toast.inviteSent"));
        setAddMemberOpen(false);
        setAddMemberEmail("");
        refreshDetail();
      },
      onError: (err) => {
        console.error(err);
        toast.error(err.message || t("toast.inviteFailed"));
      },
    },
  );

  // 移除成员（经二次确认后执行）
  const { run: runRemoveMember, loading: removeMemberLoading } = useRequest(
    (userId: string) => unwrap(orgApi.removeMember(selectedOrgId!, userId)),
    {
      manual: true,
      onSuccess: () => {
        setRemoveMemberTarget(null);
        refreshDetail();
      },
      onError: (err) => {
        console.error(err);
        toast.error(t("toast.removeFailed"));
      },
    },
  );

  // 更新角色（静默操作）
  const { run: runUpdateRole } = useRequest(
    (userId: string, newRole: string) => unwrap(orgApi.updateRole(selectedOrgId!, userId, newRole)),
    {
      manual: true,
      onSuccess: () => {
        refreshDetail();
      },
      onError: (err) => {
        console.error(err);
        toast.error(t("toast.roleUpdateFailed"));
      },
    },
  );

  // 删除组织（静默操作）
  const { run: runDelete, loading: deleteLoading } = useRequest(() => unwrap(orgApi.del(selectedOrgId!)), {
    manual: true,
    onSuccess: () => {
      setDeleteOpen(false);
      reloadOrgs();
      setSelectedOrgId(null);
      refreshOrgs();
    },
    onError: (err) => {
      console.error(err);
      toast.error(t("toast.deleteFailed"));
    },
  });

  const saveDefaultEngine = useCallback(async () => {
    if (!selectedOrgId || !detail) return;
    setSavingEngine(true);
    try {
      const metadata = {
        ...(((detail as unknown as Record<string, unknown>).metadata as Record<string, unknown>) || {}),
        defaultEngine: {
          engineType: defaultEngineType || undefined,
          machineId: defaultMachineId === "local" ? "" : defaultMachineId,
        },
      };
      await unwrap(
        orgApi.updateMetadata(selectedOrgId, {
          name: detail.name,
          slug: detail.slug,
          metadata,
        }),
      );
      toast.success(t("toast.updateSuccess"));
      setEngineDirty(false);
      refreshDetail();
    } catch (err) {
      console.error(err);
      toast.error(t("toast.updateFailed"));
    } finally {
      setSavingEngine(false);
    }
  }, [selectedOrgId, detail, defaultEngineType, defaultMachineId, refreshDetail, t]);

  const members = (detail?.members ?? []) as unknown as OrgMember[];

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1.5" />
            {t("createDialog.title")}
          </Button>
        }
      />
      <div className="flex flex-1 min-h-0">
        {/* Left: org list */}
        <div className="w-[260px] border-r border-border-subtle flex flex-col">
          <div className="flex-1 overflow-y-auto py-2">
            {myOrgs.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setSelectedOrgId(o.id)}
                className={[
                  "flex items-center gap-2 w-full px-4 py-2.5 text-left text-sm transition-colors duration-100",
                  o.id === selectedOrgId
                    ? "bg-brand-subtle text-brand-light font-medium border-l-2 border-brand"
                    : "text-text-secondary hover:bg-surface-hover",
                ].join(" ")}
              >
                <RoleIcon role={o.role} />
                <span className="truncate">{o.name}</span>
                <span className="ml-auto text-[11px] text-text-dim">
                  {t(`roles.${o.role ?? "member"}`, o.role ?? "member")}
                </span>
              </button>
            ))}
            {myOrgs.length === 0 && <p className="px-4 py-6 text-sm text-text-dim text-center">{t("noOrgs")}</p>}
          </div>
        </div>

        {/* Right: org detail */}
        <div className="flex-1 overflow-y-auto p-6">
          {detailLoading && (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          )}

          {!detailLoading && !detail && (
            <div className="flex flex-col items-center justify-center h-64 text-text-dim">
              <p className="text-sm">{t("selectOrg")}</p>
            </div>
          )}

          {!detailLoading && detail && (
            <div className="max-w-[720px] mx-auto space-y-6">
              {/* Org info */}
              <div className="space-y-3">
                {editingName ? (
                  <div className="space-y-3">
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder={t("editName.placeholder")}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          if (editName.trim()) runUpdateName(editName);
                        }}
                        disabled={updateNameLoading}
                      >
                        {updateNameLoading ? t("saving") : t("save")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditingName(false)}>
                        {t("cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-text-bright">{detail.name}</h2>
                      <p className="text-sm text-text-dim mt-0.5">{detail.slug}</p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="text-xs text-text-dim">{t("orgId")}:</span>
                        <code className="text-xs text-text-secondary bg-surface-hover px-1.5 py-0.5 rounded font-mono">
                          {detail.id}
                        </code>
                        <button
                          type="button"
                          onClick={handleCopyId}
                          className="text-text-dim hover:text-text-secondary transition-colors"
                          title={t("copyId")}
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                        {copiedId && <span className="text-xs text-green-500">{t("copied")}</span>}
                      </div>
                    </div>
                    {canManage && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditName(detail.name);
                          setEditingName(true);
                        }}
                      >
                        {t("edit")}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {/* Members */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-text-primary">{t("members", { count: members.length })}</h3>
                  {canManage && (
                    <Button size="sm" variant="outline" onClick={() => setAddMemberOpen(true)}>
                      <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                      {t("inviteMember")}
                    </Button>
                  )}
                </div>
                <div className="grid gap-2">
                  {members.map((m) => (
                    <div
                      key={m.id}
                      className="group flex items-center gap-3 rounded-lg border border-border-light bg-surface-1 px-4 py-2.5"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-text-bright">{m.user?.name || m.userId}</span>
                          <RoleBadge role={m.role} />
                        </div>
                        {m.user?.phoneNumber ? (
                          <p className="text-xs text-text-dim mt-0.5">{m.user.phoneNumber}</p>
                        ) : null}
                        <p className="text-xs text-text-dim mt-0.5">{m.user?.email}</p>
                      </div>
                      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {isOwner && m.role !== "owner" && (
                          <select
                            value={m.role}
                            onChange={(e) => runUpdateRole(m.id, e.target.value)}
                            className="text-xs border border-border-subtle rounded px-1.5 py-0.5 bg-transparent text-text-secondary"
                          >
                            <option value="admin">{t("roles.admin")}</option>
                            <option value="member">{t("roles.member")}</option>
                          </select>
                        )}
                        {canManage && m.role !== "owner" && (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="text-text-dim hover:text-destructive"
                            onClick={() => setRemoveMemberTarget(m)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                  {members.length === 0 && <p className="text-sm text-text-dim text-center py-4">{t("noMembers")}</p>}
                </div>
              </div>

              {/* 默认引擎设置 — 仅 owner 可见 */}
              {isOwner && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-text-primary">{t("defaultEngine", "默认引擎")}</h3>
                  <div className="rounded-lg border border-border-light bg-surface-1 px-4 py-3 space-y-3">
                    <div className="flex items-center gap-4">
                      <label className="text-xs text-text-secondary w-20 shrink-0">
                        {t("form.engineType", "引擎类型")}
                      </label>
                      <select
                        className="flex-1 rounded-md border border-border-light bg-surface-2 px-3 py-1.5 text-sm text-text-primary"
                        value={defaultEngineType}
                        onChange={(e) => {
                          setDefaultEngineType(e.target.value);
                          setEngineDirty(true);
                        }}
                      >
                        <option value="">{t("form.engineTypePlaceholder", "未设置")}</option>
                        <option value="opencode">OpenCode</option>
                        <option value="ccb">CCB</option>
                        <option value="claude-code">Claude Code</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-4">
                      <label className="text-xs text-text-secondary w-20 shrink-0">
                        {t("form.machine", "执行节点")}
                      </label>
                      <select
                        className="flex-1 rounded-md border border-border-light bg-surface-2 px-3 py-1.5 text-sm text-text-primary"
                        value={defaultMachineId}
                        onChange={(e) => {
                          setDefaultMachineId(e.target.value);
                          setEngineDirty(true);
                        }}
                      >
                        <option value="local">{t("form.machineLocal", "本地")}</option>
                        {machines.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name || (m.machineInfo as { hostname?: string } | null)?.hostname || m.agentName} (
                            {m.id.slice(0, 8)}){" "}
                            {m.status === "online"
                              ? t("machineStatus.online", "在线")
                              : t("machineStatus.offline", "离线")}
                          </option>
                        ))}
                      </select>
                    </div>
                    {engineDirty && (
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" onClick={saveDefaultEngine} disabled={savingEngine}>
                          {savingEngine ? t("saving") : t("save")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const metadata = (detail as unknown as Record<string, unknown>).metadata as
                              | { defaultEngine?: { engineType?: string; machineId?: string } }
                              | null
                              | undefined;
                            const def = metadata?.defaultEngine;
                            setDefaultEngineType(def?.engineType ?? "");
                            setDefaultMachineId(def?.machineId || "local");
                            setEngineDirty(false);
                          }}
                        >
                          {t("cancel")}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Machines */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-text-primary">
                    {t("machines", { count: machines.length })}
                  </h3>
                  <div className="flex items-center gap-2">
                    {canManage && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setMachineCreateResult(null);
                          setMachineFormName("");
                          setMachineFormLabels("");
                          setMachineFormAgentName("opencode");
                          setMachineCreateOpen(true);
                        }}
                      >
                        <Plus className="w-3.5 h-3.5 mr-1.5" />
                        {t("addMachine")}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={refreshMachines} disabled={machinesLoading}>
                      <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${machinesLoading ? "animate-spin" : ""}`} />
                      {machinesLoading ? t("machineRefreshing") : t("machineRefresh")}
                    </Button>
                  </div>
                </div>
                <div className="grid gap-2">
                  {machines.map((m: MachineRecord) => {
                    const isOnline = m.status === "online";
                    const hostname = (m.machineInfo?.hostname as string | undefined) ?? m.agentName;
                    return (
                      <div
                        key={m.id}
                        className="group flex items-center gap-3 rounded-lg border border-border-light bg-surface-1 px-4 py-2.5"
                      >
                        <Monitor className="w-4 h-4 text-text-dim shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-text-bright truncate">{m.name ?? hostname}</span>
                            <Badge variant={isOnline ? "default" : "outline"}>
                              {t(`machineStatus.${isOnline ? "online" : "offline"}`)}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-xs text-text-dim">
                            <span>
                              {t("machineAgent")}: <code className="font-mono">{m.agentName}</code>
                            </span>
                            {hostname && (
                              <span>
                                {t("machineHost")}: {hostname}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-xs text-text-dim">
                            {t("machineId")}: <code className="font-mono">{m.id}</code>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-text-dim hover:text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          onClick={() => {
                            navigator.clipboard.writeText(m.id);
                            toast.success(t("copied"));
                          }}
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </Button>
                        {m.labels && m.labels.length > 0 && (
                          <div className="flex items-center gap-1 shrink-0">
                            {m.labels
                              .filter((l) => l !== "remote-runtime")
                              .map((l) => (
                                <Badge key={l} variant="secondary" className="text-[10px]">
                                  {l}
                                </Badge>
                              ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {machines.length === 0 && !machinesLoading && (
                    <p className="text-sm text-text-dim text-center py-4">{t("noMachines")}</p>
                  )}
                </div>
              </div>

              {/* Danger zone */}
              {isOwner && (
                <div className="pt-4 border-t border-border-subtle">
                  <h3 className="text-sm font-semibold text-destructive mb-2">{t("dangerZone.title")}</h3>
                  <p className="text-sm text-text-dim mb-3">{t("dangerZone.description")}</p>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setDeleteOpen(true)}
                    disabled={myOrgs.length <= 1}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    {t("dangerZone.deleteOrg")}
                  </Button>
                  {myOrgs.length <= 1 && (
                    <p className="text-xs text-text-dim mt-2">{t("dangerZone.cannotDeleteLast")}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Create org dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createDialog.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-sm font-medium text-text-primary">{t("createDialog.name")}</label>
              <Input
                className="mt-1"
                value={formName}
                onChange={(e) => {
                  setFormName(e.target.value);
                  if (!formSlug || formSlug === nameToSlug(formName)) {
                    setFormSlug(nameToSlug(e.target.value));
                  }
                }}
                placeholder={t("createDialog.namePlaceholder")}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("createDialog.slug")}</label>
              <Input
                className="mt-1"
                value={formSlug}
                onChange={(e) => setFormSlug(e.target.value)}
                placeholder="url-identifier"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("createDialog.description")}</label>
              <Input
                className="mt-1"
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                placeholder={t("createDialog.descriptionPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={() => {
                if (formName.trim()) runCreate(formName, formSlug);
              }}
              disabled={createLoading || !formName.trim()}
            >
              {createLoading ? t("creating") : t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add member dialog */}
      <Dialog open={addMemberOpen} onOpenChange={setAddMemberOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("inviteDialog.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-sm font-medium text-text-primary">{t("inviteDialog.email")}</label>
              <Input
                className="mt-1"
                value={addMemberEmail}
                onChange={(e) => setAddMemberEmail(e.target.value)}
                placeholder={t("inviteDialog.emailPlaceholder")}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("inviteDialog.role")}</label>
              <select
                value={addMemberRole}
                onChange={(e) => setAddMemberRole(e.target.value)}
                className="mt-1 w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="admin">{t("roles.admin")}</option>
                <option value="member">{t("roles.member")}</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddMemberOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={() => {
                if (addMemberEmail.trim()) runAddMember(addMemberEmail, addMemberRole);
              }}
              disabled={addMemberLoading || !addMemberEmail.trim()}
            >
              {addMemberLoading ? t("inviteDialog.inviting") : t("inviteDialog.invite")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete org confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteDialog.description", { name: detail?.name })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => runDelete()}
              disabled={deleteLoading}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleteLoading ? t("deleteDialog.deleting") : t("deleteDialog.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove member confirmation */}
      <AlertDialog
        open={!!removeMemberTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveMemberTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeMemberDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeMemberDialog.description", {
                name: removeMemberTarget?.user?.name || removeMemberTarget?.userId,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeMemberTarget && runRemoveMember(removeMemberTarget.id)}
              disabled={removeMemberLoading}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {removeMemberLoading ? t("removeMemberDialog.removing") : t("removeMemberDialog.confirmRemove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create machine dialog */}
      <Dialog
        open={machineCreateOpen}
        onOpenChange={(open) => {
          if (!open) {
            setMachineCreateOpen(false);
            setMachineCreateResult(null);
            setMachineFormName("");
            setMachineFormLabels("");
            setMachineFormAgentName("opencode");
          }
        }}
      >
        <DialogContent>
          {machineCreateResult ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("createMachineDialog.resultTitle")}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <p className="text-sm text-text-secondary">{t("createMachineDialog.resultDesc")}</p>
                <div>
                  <label className="text-xs font-medium text-text-dim">{t("machineId")}</label>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="flex-1 text-sm bg-surface-hover px-3 py-2 rounded font-mono break-all">
                      {machineCreateResult.id}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard.writeText(machineCreateResult.id);
                        toast.success(t("copied"));
                      }}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-text-dim">{t("createMachineDialog.initCommand")}</label>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="flex-1 text-xs bg-surface-hover px-3 py-2 rounded font-mono break-all">
                      {machineCreateResult.initCommand}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard.writeText(machineCreateResult.initCommand);
                        toast.success(t("copied"));
                      }}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => {
                    setMachineCreateOpen(false);
                    setMachineCreateResult(null);
                    setMachineFormName("");
                    setMachineFormLabels("");
                    setMachineFormAgentName("opencode");
                  }}
                >
                  {t("done")}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t("createMachineDialog.title")}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <div>
                  <label className="text-sm font-medium text-text-primary">{t("createMachineDialog.name")}</label>
                  <Input
                    className="mt-1"
                    value={machineFormName}
                    onChange={(e) => setMachineFormName(e.target.value)}
                    placeholder={t("createMachineDialog.namePlaceholder")}
                    maxLength={64}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-text-primary">{t("createMachineDialog.labels")}</label>
                  <Input
                    className="mt-1"
                    value={machineFormLabels}
                    onChange={(e) => setMachineFormLabels(e.target.value)}
                    placeholder={t("createMachineDialog.labelsPlaceholder")}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-text-primary">{t("createMachineDialog.agentName")}</label>
                  <select
                    value={machineFormAgentName}
                    onChange={(e) => setMachineFormAgentName(e.target.value)}
                    className="mt-1 w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  >
                    <option value="opencode">OpenCode</option>
                    <option value="ccb">CCB</option>
                    <option value="claude-code">Claude Code</option>
                  </select>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setMachineCreateOpen(false)}>
                  {t("cancel")}
                </Button>
                <Button
                  onClick={() => {
                    const name = machineFormName.trim();
                    if (!name) return;
                    const labels = machineFormLabels
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean);
                    runCreateMachine(name, labels, machineFormAgentName);
                  }}
                  disabled={createMachineLoading || !machineFormName.trim()}
                >
                  {createMachineLoading ? t("creating") : t("create")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
