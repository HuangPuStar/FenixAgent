import type { OrgDetail, OrgMember, OrgMemberCandidate } from "@/src/api/organizations";
import type { MachineRecord } from "@/src/api/registry";

export interface OrganizationListItem {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface MachineFormState {
  name: string;
  labels: string;
  agentName: string;
}

export interface MachineCreateResult {
  id: string;
  name: string;
  initCommand: string;
}

export interface OrganizationsWorkspaceProps {
  organizations: OrganizationListItem[];
  selectedOrgId: string | null;
  onSelectOrg: (id: string) => void;
  detail?: OrgDetail;
  detailLoading: boolean;
  members: OrgMember[];
  machines: MachineRecord[];
  machinesLoading: boolean;
  canManage: boolean;
  isOwner: boolean;
  currentUserId: string | null;
  editingName: boolean;
  editName: string;
  updateNameLoading: boolean;
  copiedId: boolean;
  defaultMachineId: string;
  engineDirty: boolean;
  savingEngine: boolean;
  onEditNameChange: (value: string) => void;
  onStartEditName: () => void;
  onCancelEditName: () => void;
  onSaveName: () => void;
  onCopyId: () => void;
  onOpenInvite: () => void;
  onUpdateRole: (memberId: string, role: string) => void;
  onRemoveMember: (member: OrgMember) => void;
  onDefaultMachineChange: (machineId: string) => void;
  onSaveDefaultEngine: () => void;
  onCancelDefaultEngine: () => void;
  onOpenCreateMachine: () => void;
  onRefreshMachines: () => void;
  onEditMachine: (machine: MachineRecord) => void;
  onDeleteMachine: (machine: MachineRecord) => void;
  onDeleteOrganization: () => void;
}

export interface OrganizationsDialogsProps {
  createOpen: boolean;
  formName: string;
  formSlug: string;
  createLoading: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onFormNameChange: (value: string) => void;
  onFormSlugChange: (value: string) => void;
  onCreate: () => void;
  inviteOpen: boolean;
  inviteKeyword: string;
  debouncedInviteKeyword: string;
  selectedCandidates: OrgMemberCandidate[];
  memberCandidates: OrgMemberCandidate[];
  memberCandidatesLoading: boolean;
  inviteRole: string;
  inviteLoading: boolean;
  onInviteOpenChange: (open: boolean) => void;
  onInviteKeywordChange: (value: string) => void;
  onCandidateAdd: (candidate: OrgMemberCandidate) => void;
  onCandidateRemove: (candidateId: string) => void;
  onInviteRoleChange: (role: string) => void;
  onInvite: () => void;
  deleteOpen: boolean;
  organizationName?: string;
  deleteLoading: boolean;
  onDeleteOpenChange: (open: boolean) => void;
  onDelete: () => void;
  removeMemberTarget: OrgMember | null;
  removeMemberLoading: boolean;
  onRemoveMemberTargetChange: (member: OrgMember | null) => void;
  onConfirmRemoveMember: () => void;
  machineCreateOpen: boolean;
  machineEditOpen: boolean;
  machineDeleteTarget: MachineRecord | null;
  machineCreateResult: MachineCreateResult | null;
  machineForm: MachineFormState;
  createMachineLoading: boolean;
  updateMachineLoading: boolean;
  deleteMachineLoading: boolean;
  onMachineCreateOpenChange: (open: boolean) => void;
  onMachineEditOpenChange: (open: boolean) => void;
  onMachineDeleteTargetChange: (machine: MachineRecord | null) => void;
  onMachineFormChange: (form: MachineFormState) => void;
  onCreateMachine: () => void;
  onUpdateMachine: () => void;
  onDeleteMachine: () => void;
}
