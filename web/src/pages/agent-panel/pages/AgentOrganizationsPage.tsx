import { Plus, Shield, ShieldCheck, Trash2, User, UserPlus } from "lucide-react";
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
import { orgApi } from "@/src/api/sdk";
import { useOrg } from "../../../contexts/OrgContext";
import { AgentPageHeader } from "../shared/AgentPageHeader";

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

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [loading, setLoading] = useState(false);

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

  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const [editSaving, setEditSaving] = useState(false);

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

  useEffect(() => {
    if (!selectedOrgId && currentOrg?.id) {
      setSelectedOrgId(currentOrg.id);
    }
  }, [selectedOrgId, currentOrg]);

  useEffect(() => {
    if (!selectedOrgId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    orgApi
      .get(selectedOrgId)
      .then(({ data, error }: { data?: unknown; error?: unknown }) => {
        if (error) {
          console.error(error);
          toast.error(t("toast.loadDetailFailed"));
          return;
        }
        setDetail(data as OrgDetail);
      })
      .finally(() => setLoading(false));
  }, [selectedOrgId, t]);

  const selectedOrgRole = myOrgs.find((o) => o.id === selectedOrgId)?.role;
  const canManage = selectedOrgRole === "owner" || selectedOrgRole === "admin";
  const isOwner = selectedOrgRole === "owner";

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

  return (
    <div className="flex flex-col flex-1 min-h-0">
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
          {loading && (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
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
                      <h2 className="text-lg font-bold text-text-bright">{detail.name}</h2>
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
                        <p className="text-xs text-text-dim mt-0.5">{m.user?.email}</p>
                      </div>
                      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
                            size="xs"
                            className="text-text-dim hover:text-destructive"
                            onClick={() => handleRemoveMember(m.id)}
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
