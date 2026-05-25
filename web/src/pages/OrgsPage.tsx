import { Plus, Shield, ShieldCheck, Trash2, User, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { orgApi } from "@/src/api/sdk";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { useOrg } from "../contexts/OrgContext";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface OrgMember {
  id: string;
  userId: string;
  role: string;
  user: { id: string; name: string; email: string; image?: string };
}

interface OrgDetail {
  id: string;
  name: string;
  slug: string;
  logo?: string;
  members: OrgMember[];
}

/* ------------------------------------------------------------------ */
/*  Role helpers                                                       */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Slug generator                                                     */
/* ------------------------------------------------------------------ */

function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function OrgsPage() {
  const { t } = useTranslation("orgs");
  const { org: currentOrg, role: currentRole, refreshOrgs } = useOrg();

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [loading, setLoading] = useState(false);

  // Dialog states
  const [createOpen, setCreateOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formSaving, setFormSaving] = useState(false);

  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [addMemberEmail, setAddMemberEmail] = useState("");
  const [addMemberRole, setAddMemberRole] = useState("member");
  const [addMemberSaving, setAddMemberSaving] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteSaving, setDeleteSaving] = useState(false);

  // Edit org name
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // Load my orgs list
  const [myOrgs, setMyOrgs] = useState<{ id: string; name: string; slug: string; role: string }[]>([]);

  const loadMyOrgs = useCallback(async () => {
    const { data, error } = await orgApi.list();
    if (error) {
      console.error(error);
      return;
    }
    setMyOrgs((data ?? []) as unknown as typeof myOrgs);
  }, []);

  useEffect(() => {
    loadMyOrgs();
  }, [loadMyOrgs]);

  // Auto-select current org
  useEffect(() => {
    if (!selectedOrgId && currentOrg?.id) {
      setSelectedOrgId(currentOrg.id);
    }
  }, [selectedOrgId, currentOrg]);

  // Load org detail when selection changes
  useEffect(() => {
    if (!selectedOrgId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    orgApi
      .get(selectedOrgId)
      .then(({ data, error }) => {
        if (error) {
          console.error(error);
          toast.error(t("toast.loadDetailFailed"));
          return;
        }
        setDetail(data);
      })
      .finally(() => setLoading(false));
  }, [selectedOrgId, t]);

  const canManage = currentRole === "owner" || currentRole === "admin";
  const isOwner = currentRole === "owner";

  // --- Create org ---
  const handleCreate = async () => {
    if (!formName.trim()) return;
    setFormSaving(true);
    const { data, error } = await orgApi.create({
      name: formName.trim(),
      slug: formSlug || nameToSlug(formName),
    });
    if (error) {
      console.error(error);
      toast.error(t("toast.createFailed"));
      setFormSaving(false);
      return;
    }
    toast.success(t("toast.createSuccess"));
    setCreateOpen(false);
    setFormName("");
    setFormSlug("");
    setFormDesc("");
    await loadMyOrgs();
    await refreshOrgs();
    setSelectedOrgId(data.id);
    setFormSaving(false);
  };

  // --- Update org info ---
  const handleSaveEdit = async () => {
    if (!selectedOrgId || !editName.trim()) return;
    setEditSaving(true);
    const { error } = await orgApi.update(selectedOrgId, { name: editName.trim() });
    if (error) {
      console.error(error);
      toast.error(t("toast.updateFailed"));
      setEditSaving(false);
      return;
    }
    toast.success(t("toast.updateSuccess"));
    setEditingName(false);
    setDetail((d) => (d ? { ...d, name: editName.trim() } : d));
    await loadMyOrgs();
    await refreshOrgs();
    setEditSaving(false);
  };

  // --- Add member (invite) ---
  const handleAddMember = async () => {
    if (!selectedOrgId || !addMemberEmail.trim()) return;
    setAddMemberSaving(true);
    const { error: addErr } = await orgApi.addMember(selectedOrgId, {
      email: addMemberEmail.trim(),
      role: addMemberRole,
    });
    if (addErr) {
      console.error(addErr);
      toast.error(addErr.message || t("toast.inviteFailed"));
      setAddMemberSaving(false);
      return;
    }
    toast.success(t("toast.inviteSent"));
    setAddMemberOpen(false);
    setAddMemberEmail("");
    const { data: d2 } = await orgApi.get(selectedOrgId);
    if (d2) setDetail(d2);
    setAddMemberSaving(false);
  };

  // --- Remove member ---
  const handleRemoveMember = async (userId: string) => {
    if (!selectedOrgId) return;
    const { error: rmErr } = await orgApi.removeMember(selectedOrgId, userId);
    if (rmErr) {
      console.error(rmErr);
      toast.error(t("toast.removeFailed"));
      return;
    }
    toast.success(t("toast.removeSuccess"));
    const { data: d3 } = await orgApi.get(selectedOrgId);
    if (d3) setDetail(d3);
  };

  // --- Update role ---
  const handleUpdateRole = async (userId: string, newRole: string) => {
    if (!selectedOrgId) return;
    const { error: roleErr } = await orgApi.updateRole(selectedOrgId, userId, newRole);
    if (roleErr) {
      console.error(roleErr);
      toast.error(t("toast.roleUpdateFailed"));
      return;
    }
    toast.success(t("toast.roleUpdated"));
    const { data: d4 } = await orgApi.get(selectedOrgId);
    if (d4) setDetail(d4);
  };

  // --- Delete org ---
  const handleDeleteOrg = async () => {
    if (!selectedOrgId) return;
    setDeleteSaving(true);
    const { error: delErr } = await orgApi.delete(selectedOrgId);
    if (delErr) {
      console.error(delErr);
      toast.error(t("toast.deleteFailed"));
      setDeleteSaving(false);
      return;
    }
    toast.success(t("toast.deleteSuccess"));
    setDeleteOpen(false);
    setDetail(null);
    await loadMyOrgs();
    setSelectedOrgId(null);
    await refreshOrgs();
    setDeleteSaving(false);
  };

  const members = detail?.members ?? [];

  /* ---- Render ---- */

  return (
    <div className="flex h-full">
      {/* Left panel: org list */}
      <div className="w-[260px] border-r border-border-subtle flex flex-col bg-surface-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-bright">{t("myOrgs")}</h2>
          <Button variant="ghost" size="sm" onClick={() => setCreateOpen(true)} className="h-7 w-7 p-0">
            <Plus className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {myOrgs.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setSelectedOrgId(o.id)}
              className={[
                "flex items-center gap-2 w-full px-4 py-2.5 text-left text-sm",
                "transition-colors duration-100",
                o.id === selectedOrgId
                  ? "bg-brand-subtle text-brand-light font-medium"
                  : "text-text-secondary hover:bg-surface-hover",
              ].join(" ")}
            >
              <RoleIcon role={o.role} />
              <span className="truncate">{o.name}</span>
              <span className="ml-auto text-[11px] text-text-dim">{t(`roles.${o.role}`, o.role)}</span>
            </button>
          ))}
          {myOrgs.length === 0 && <p className="px-4 py-6 text-sm text-text-dim text-center">{t("noOrgs")}</p>}
        </div>
      </div>

      {/* Right panel: org detail */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading && (
          <div className="flex items-center justify-center h-64">
            <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
          </div>
        )}

        {!loading && !detail && (
          <div className="flex flex-col items-center justify-center h-64 text-text-dim">
            <p className="text-sm">{t("selectOrg")}</p>
          </div>
        )}

        {!loading && detail && (
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
                    <Button size="sm" onClick={handleSaveEdit} disabled={editSaving}>
                      {editSaving ? t("saving") : t("save")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingName(false)}>
                      {t("cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between">
                  <div>
                    <h1 className="text-xl font-bold text-text-bright">{detail.name}</h1>
                    <p className="text-sm text-text-dim mt-0.5">{detail.slug}</p>
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

            {/* Members section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-primary">{t("members", { count: members.length })}</h2>
                {canManage && (
                  <Button size="sm" variant="outline" onClick={() => setAddMemberOpen(true)}>
                    <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                    {t("inviteMember")}
                  </Button>
                )}
              </div>

              <div className="rounded-lg border border-border-subtle overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-surface-1 text-text-dim">
                      <th className="text-left px-4 py-2.5 font-medium">{t("table.user")}</th>
                      <th className="text-left px-4 py-2.5 font-medium">{t("table.role")}</th>
                      <th className="text-right px-4 py-2.5 font-medium">{t("table.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id} className="border-t border-border-subtle hover:bg-surface-hover">
                        <td className="px-4 py-2.5">
                          <div>
                            <p className="font-medium text-text-primary">{m.user?.name || m.userId}</p>
                            <p className="text-xs text-text-dim">{m.user?.email}</p>
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <RoleBadge role={m.role} />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {isOwner && m.role !== "owner" && (
                              <select
                                value={m.role}
                                onChange={(e) => handleUpdateRole(m.id, e.target.value)}
                                className="text-xs border border-border-subtle rounded px-1.5 py-0.5 bg-transparent text-text-secondary"
                              >
                                <option value="admin">{t("roles.admin")}</option>
                                <option value="member">{t("roles.member")}</option>
                              </select>
                            )}
                            {canManage && m.role !== "owner" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-text-dim hover:text-destructive"
                                onClick={() => handleRemoveMember(m.id)}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {members.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-4 py-6 text-center text-text-dim">
                          {t("noMembers")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
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
                {myOrgs.length <= 1 && <p className="text-xs text-text-dim mt-2">{t("dangerZone.cannotDeleteLast")}</p>}
              </div>
            )}
          </div>
        )}
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
            <Button onClick={handleCreate} disabled={formSaving || !formName.trim()}>
              {formSaving ? t("creating") : t("create")}
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
            <Button onClick={handleAddMember} disabled={addMemberSaving || !addMemberEmail.trim()}>
              {addMemberSaving ? t("inviteDialog.inviting") : t("inviteDialog.invite")}
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
              onClick={handleDeleteOrg}
              disabled={deleteSaving}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleteSaving ? t("deleteDialog.deleting") : t("deleteDialog.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
