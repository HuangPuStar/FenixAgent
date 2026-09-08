import { useRequest } from "ahooks";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type OrgMember, type OrgMemberCandidate, orgApi } from "@/src/api/organizations";
import { type MachineRecord, registryApi } from "@/src/api/registry";
import { unwrap } from "@/src/api/request";
import { AppHeader } from "@/src/components/layout/app-header";
import { AppPage } from "@/src/components/layout/app-page";
import { useSession } from "@/src/lib/auth-client";
import { useOrg } from "../../../contexts/OrgContext";
import { OrganizationsDialogs } from "./agent-organizations-dialogs";
import "./agent-organizations.css";
import type { MachineCreateResult, MachineFormState, OrganizationListItem } from "./agent-organizations-types";
import { nameToSlug, parseLabels, readDefaultMachineId } from "./agent-organizations-utils";
import { OrganizationsWorkspace } from "./agent-organizations-workspace";

const EMPTY_MACHINE_FORM: MachineFormState = { name: "", labels: "", agentName: "opencode" };

export function AgentOrganizationsPage() {
  const { t } = useTranslation("orgs");
  const { org: currentOrg, refreshOrgs } = useOrg();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id ?? null;
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const [copiedId, setCopiedId] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteKeyword, setInviteKeyword] = useState("");
  const [debouncedInviteKeyword, setDebouncedInviteKeyword] = useState("");
  const [selectedCandidates, setSelectedCandidates] = useState<OrgMemberCandidate[]>([]);
  const [inviteRole, setInviteRole] = useState("member");
  const [removeMemberTarget, setRemoveMemberTarget] = useState<OrgMember | null>(null);
  const [defaultMachineId, setDefaultMachineId] = useState("local");
  const [engineDirty, setEngineDirty] = useState(false);
  const [savingEngine, setSavingEngine] = useState(false);
  const [machineCreateOpen, setMachineCreateOpen] = useState(false);
  const [machineEditOpen, setMachineEditOpen] = useState(false);
  const [machineDeleteTarget, setMachineDeleteTarget] = useState<MachineRecord | null>(null);
  const [machineEditTarget, setMachineEditTarget] = useState<MachineRecord | null>(null);
  const [machineForm, setMachineForm] = useState<MachineFormState>(EMPTY_MACHINE_FORM);
  const [machineCreateResult, setMachineCreateResult] = useState<MachineCreateResult | null>(null);

  const { data: organizationsRaw = [], refresh: reloadOrganizations } = useRequest(() => unwrap(orgApi.list()), {
    onError: (error) => {
      console.error("Failed to load organizations", error);
      toast.error(t("toast.loadDetailFailed"));
    },
  });
  const organizations = organizationsRaw as OrganizationListItem[];
  const {
    data: detail,
    loading: detailLoading,
    refresh: refreshDetail,
  } = useRequest(() => unwrap(orgApi.get(selectedOrgId!)), {
    ready: !!selectedOrgId,
    refreshDeps: [selectedOrgId],
    onError: (error) => {
      console.error("Failed to load organization detail", error);
      toast.error(t("toast.loadDetailFailed"));
    },
  });
  const {
    data: machinesResponse,
    loading: machinesLoading,
    refresh: refreshMachines,
  } = useRequest(() => unwrap(registryApi.list({ limit: 50 })), {
    ready: !!selectedOrgId,
    refreshDeps: [selectedOrgId],
  });
  const machines = machinesResponse?.items ?? [];
  const members = detail?.members ?? [];
  const selectedRole = organizations.find((organization) => organization.id === selectedOrgId)?.role;
  const canManage = selectedRole === "owner" || selectedRole === "admin";
  const isOwner = selectedRole === "owner";

  useEffect(() => {
    if (selectedOrgId) return;
    setSelectedOrgId(currentOrg?.id ?? organizations[0]?.id ?? null);
  }, [currentOrg, organizations, selectedOrgId]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedInviteKeyword(inviteKeyword.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [inviteKeyword]);
  useEffect(() => {
    if (!detail) return;
    setDefaultMachineId(readDefaultMachineId(detail.metadata));
    setEngineDirty(false);
  }, [detail]);

  const resetCreateOrganization = useCallback(() => {
    setFormName("");
    setFormSlug("");
  }, []);
  const resetInvite = useCallback(() => {
    setInviteKeyword("");
    setDebouncedInviteKeyword("");
    setSelectedCandidates([]);
    setInviteRole("member");
  }, []);
  const resetMachine = useCallback(() => {
    setMachineForm(EMPTY_MACHINE_FORM);
    setMachineEditTarget(null);
    setMachineCreateResult(null);
  }, []);

  const { run: runCreate, loading: createLoading } = useRequest(
    (name: string, slug: string) => unwrap(orgApi.create({ name: name.trim(), slug: slug || nameToSlug(name) })),
    {
      manual: true,
      onSuccess: (organization) => {
        toast.success(t("toast.createSuccess"));
        setCreateOpen(false);
        resetCreateOrganization();
        reloadOrganizations();
        refreshOrgs();
        setSelectedOrgId(organization.id);
      },
      onError: (error) => {
        console.error("Failed to create organization", error);
        toast.error(t("toast.createFailed"));
      },
    },
  );
  const { run: runUpdateName, loading: updateNameLoading } = useRequest(
    (name: string) => unwrap(orgApi.update(selectedOrgId!, { name: name.trim() })),
    {
      manual: true,
      onSuccess: () => {
        setEditingName(false);
        refreshDetail();
        reloadOrganizations();
        refreshOrgs();
      },
      onError: (error) => {
        console.error("Failed to update organization", error);
        toast.error(t("toast.updateFailed"));
      },
    },
  );
  const { data: memberCandidates = [], loading: memberCandidatesLoading } = useRequest(
    () => unwrap(orgApi.searchMemberCandidates(selectedOrgId!, debouncedInviteKeyword)),
    {
      ready: inviteOpen && !!selectedOrgId && debouncedInviteKeyword.length >= 3,
      refreshDeps: [inviteOpen, selectedOrgId, debouncedInviteKeyword],
    },
  );
  const { run: runAddMember, loading: inviteLoading } = useRequest(
    (candidates: OrgMemberCandidate[], role: string) =>
      unwrap(orgApi.addMember(selectedOrgId!, { userIds: candidates.map((candidate) => candidate.id), role })),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("toast.inviteSent"));
        setInviteOpen(false);
        resetInvite();
        refreshDetail();
      },
      onError: (error) => {
        console.error("Failed to add organization members", error);
        toast.error(error instanceof Error ? error.message : t("toast.inviteFailed"));
      },
    },
  );
  const { run: runRemoveMember, loading: removeMemberLoading } = useRequest(
    (memberId: string) => unwrap(orgApi.removeMember(selectedOrgId!, memberId)),
    {
      manual: true,
      onSuccess: () => {
        setRemoveMemberTarget(null);
        refreshDetail();
      },
      onError: (error) => {
        console.error("Failed to remove member", error);
        toast.error(t("toast.removeFailed"));
      },
    },
  );
  const { run: runUpdateRole } = useRequest(
    (memberId: string, role: string) => unwrap(orgApi.updateRole(selectedOrgId!, memberId, role)),
    {
      manual: true,
      onSuccess: refreshDetail,
      onError: (error) => {
        console.error("Failed to update member role", error);
        toast.error(t("toast.roleUpdateFailed"));
      },
    },
  );
  const { run: runDelete, loading: deleteLoading } = useRequest(() => unwrap(orgApi.del(selectedOrgId!)), {
    manual: true,
    onSuccess: () => {
      setDeleteOpen(false);
      setSelectedOrgId(null);
      reloadOrganizations();
      refreshOrgs();
    },
    onError: (error) => {
      console.error("Failed to delete organization", error);
      toast.error(t("toast.deleteFailed"));
    },
  });

  const { run: runCreateMachine, loading: createMachineLoading } = useRequest(
    (form: MachineFormState) =>
      unwrap(
        registryApi.create({ name: form.name.trim(), labels: parseLabels(form.labels), agentName: form.agentName }),
      ),
    {
      manual: true,
      onSuccess: (result) => {
        setMachineCreateResult(result);
        refreshMachines();
      },
      onError: (error) => {
        console.error("Failed to create machine", error);
        toast.error(t("toast.machineCreateFailed"));
      },
    },
  );
  const { run: runUpdateMachine, loading: updateMachineLoading } = useRequest(
    (machineId: string, form: MachineFormState) =>
      unwrap(
        registryApi.update(machineId, {
          name: form.name.trim(),
          labels: parseLabels(form.labels),
          agentName: form.agentName,
        }),
      ),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("toast.machineUpdateSuccess"));
        setMachineEditOpen(false);
        resetMachine();
        refreshMachines();
      },
      onError: (error) => {
        console.error("Failed to update machine", error);
        toast.error(error instanceof Error ? error.message : t("toast.machineUpdateFailed"));
      },
    },
  );
  const { run: runDeleteMachine, loading: deleteMachineLoading } = useRequest(
    (machineId: string) => unwrap(registryApi.remove(machineId)),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("toast.machineDeleteSuccess"));
        setMachineDeleteTarget(null);
        refreshMachines();
      },
      onError: (error) => {
        console.error("Failed to delete machine", error);
        toast.error(error instanceof Error ? error.message : t("toast.machineDeleteFailed"));
      },
    },
  );

  const saveDefaultEngine = useCallback(async () => {
    if (!selectedOrgId || !detail) return;
    setSavingEngine(true);
    try {
      await unwrap(
        orgApi.updateMetadata(selectedOrgId, {
          name: detail.name,
          slug: detail.slug,
          metadata: {
            ...(detail.metadata ?? {}),
            defaultEngine: { machineId: defaultMachineId === "local" ? "" : defaultMachineId },
          },
        }),
      );
      toast.success(t("toast.updateSuccess"));
      setEngineDirty(false);
      refreshDetail();
    } catch (error) {
      console.error("Failed to update default engine", error);
      toast.error(t("toast.updateFailed"));
    } finally {
      setSavingEngine(false);
    }
  }, [defaultMachineId, detail, refreshDetail, selectedOrgId, t]);

  const handleCopyId = useCallback(() => {
    if (!selectedOrgId) return;
    navigator.clipboard.writeText(selectedOrgId);
    setCopiedId(true);
    window.setTimeout(() => setCopiedId(false), 2000);
  }, [selectedOrgId]);

  return (
    <AppPage className="agent-organizations-page">
      <AppHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {t("createDialog.title")}
          </Button>
        }
      />
      <OrganizationsWorkspace
        organizations={organizations}
        selectedOrgId={selectedOrgId}
        onSelectOrg={setSelectedOrgId}
        detail={detail}
        detailLoading={detailLoading}
        members={members}
        machines={machines}
        machinesLoading={machinesLoading}
        canManage={canManage}
        isOwner={isOwner}
        currentUserId={currentUserId}
        editingName={editingName}
        editName={editName}
        updateNameLoading={updateNameLoading}
        copiedId={copiedId}
        defaultMachineId={defaultMachineId}
        engineDirty={engineDirty}
        savingEngine={savingEngine}
        onEditNameChange={setEditName}
        onStartEditName={() => {
          setEditName(detail?.name ?? "");
          setEditingName(true);
        }}
        onCancelEditName={() => setEditingName(false)}
        onSaveName={() => editName.trim() && runUpdateName(editName)}
        onCopyId={handleCopyId}
        onOpenInvite={() => setInviteOpen(true)}
        onUpdateRole={runUpdateRole}
        onRemoveMember={setRemoveMemberTarget}
        onDefaultMachineChange={(machineId) => {
          setDefaultMachineId(machineId);
          setEngineDirty(true);
        }}
        onSaveDefaultEngine={saveDefaultEngine}
        onCancelDefaultEngine={() => {
          setDefaultMachineId(readDefaultMachineId(detail?.metadata));
          setEngineDirty(false);
        }}
        onOpenCreateMachine={() => {
          resetMachine();
          setMachineCreateOpen(true);
        }}
        onRefreshMachines={refreshMachines}
        onEditMachine={(machine) => {
          setMachineEditTarget(machine);
          setMachineForm({
            name: machine.name ?? "",
            labels: (machine.labels ?? []).filter(Boolean).join(", "),
            agentName: machine.agentName,
          });
          setMachineEditOpen(true);
        }}
        onDeleteMachine={setMachineDeleteTarget}
        onDeleteOrganization={() => setDeleteOpen(true)}
      />
      <OrganizationsDialogs
        createOpen={createOpen}
        formName={formName}
        formSlug={formSlug}
        createLoading={createLoading}
        onCreateOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetCreateOrganization();
        }}
        onFormNameChange={(name) => {
          const previousSlug = nameToSlug(formName);
          setFormName(name);
          if (!formSlug || formSlug === previousSlug) setFormSlug(nameToSlug(name));
        }}
        onFormSlugChange={setFormSlug}
        onCreate={() => runCreate(formName, formSlug)}
        inviteOpen={inviteOpen}
        inviteKeyword={inviteKeyword}
        debouncedInviteKeyword={debouncedInviteKeyword}
        selectedCandidates={selectedCandidates}
        memberCandidates={memberCandidates}
        memberCandidatesLoading={memberCandidatesLoading}
        inviteRole={inviteRole}
        inviteLoading={inviteLoading}
        onInviteOpenChange={(open) => {
          setInviteOpen(open);
          if (!open) resetInvite();
        }}
        onInviteKeywordChange={setInviteKeyword}
        onCandidateAdd={(candidate) => {
          setSelectedCandidates((current) => [...current, candidate]);
          setInviteKeyword("");
          setDebouncedInviteKeyword("");
        }}
        onCandidateRemove={(candidateId) =>
          setSelectedCandidates((current) => current.filter((candidate) => candidate.id !== candidateId))
        }
        onInviteRoleChange={setInviteRole}
        onInvite={() => runAddMember(selectedCandidates, inviteRole)}
        deleteOpen={deleteOpen}
        organizationName={detail?.name}
        deleteLoading={deleteLoading}
        onDeleteOpenChange={setDeleteOpen}
        onDelete={runDelete}
        removeMemberTarget={removeMemberTarget}
        removeMemberLoading={removeMemberLoading}
        onRemoveMemberTargetChange={setRemoveMemberTarget}
        onConfirmRemoveMember={() => removeMemberTarget && runRemoveMember(removeMemberTarget.id)}
        machineCreateOpen={machineCreateOpen}
        machineEditOpen={machineEditOpen}
        machineDeleteTarget={machineDeleteTarget}
        machineCreateResult={machineCreateResult}
        machineForm={machineForm}
        createMachineLoading={createMachineLoading}
        updateMachineLoading={updateMachineLoading}
        deleteMachineLoading={deleteMachineLoading}
        onMachineCreateOpenChange={(open) => {
          setMachineCreateOpen(open);
          if (!open) resetMachine();
        }}
        onMachineEditOpenChange={(open) => {
          setMachineEditOpen(open);
          if (!open) resetMachine();
        }}
        onMachineDeleteTargetChange={setMachineDeleteTarget}
        onMachineFormChange={setMachineForm}
        onCreateMachine={() => runCreateMachine(machineForm)}
        onUpdateMachine={() => machineEditTarget && runUpdateMachine(machineEditTarget.id, machineForm)}
        onDeleteMachine={() => machineDeleteTarget && runDeleteMachine(machineDeleteTarget.id)}
      />
    </AppPage>
  );
}
