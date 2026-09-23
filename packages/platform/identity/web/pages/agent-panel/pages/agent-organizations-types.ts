import type { ApiResponse } from "@fenix/web-runtime/api/request";
import type { OrgDetail, OrgMember, OrgMemberCandidate } from "../../../api/organizations";

/**
 * 组织页消费的机器视图模型。
 *
 * 只声明本页真正读取的字段。机器注册表的真相来源是 `@fenix/resource-machine`，但
 * `ce-ee-engineering-standards.md` §2.3 禁止 platform 实现依赖 resources（`identity` 行的禁列含
 * `resources`），因此本页**不** import 对方的 `MachineView`，而是声明自己需要的窄视图；宿主在
 * route adapter 处把 `@fenix/resource-machine/web` 的 `registryApi` 作为 {@link MachineRegistryPort}
 * 注入，结构化类型在组合根对齐——字段漂移会在那里变成编译错误，而不是在运行时静默取到 undefined。
 *
 * 归属说明：机器本身属 machine 域的 UI（机器列表、新建/删除）在 §1.6 的 WebShell 边界内仍由
 * 组织页承载（组织与机器是一对多的绑定关系，拆开会把同一条绑定关系切成两个页面），
 * 但**能力来源**经端口注入，组织页不持有机器协议。
 */
export interface MachineView {
  id: string;
  /** 用户自定义名称；未设置时为 null，展示回退到 `agentName` */
  name: string | null;
  /** 引擎名称 */
  agentName: string;
  /** 机器状态，如 "online"、"offline" */
  status: string;
  /** 所属组织 ID；无组织隔离时为 null */
  organizationId: string | null;
  /** 关联用户 ID；未绑定时为 null */
  userId: string | null;
  /** 标签列表 */
  labels?: string[] | null;
  /** 机器基础信息，如 hostname / ip */
  machineInfo?: Record<string, unknown> | null;
}

/**
 * 机器注册表端口：宿主注入的实现就是 `@fenix/resource-machine/web` 的 `registryApi`。
 *
 * 返回 `ApiResponse<T>` 而不是解包后的数据，是为了让注入点可以是裸的 `registryApi` 本身
 * （零 adapter 代码）：解包仍在调用方经 `unwrap()` 完成，错误语义与包内其它 API 客户端一致。
 * 方法用 method syntax 声明，参数按需收窄（如 `list` 只要求 `limit`），因此
 * `registryApi` 逐项满足本端口而无需类型断言。
 */
export interface MachineRegistryPort {
  /** 分页查询机器注册列表 */
  list(query?: { limit?: number }): Promise<ApiResponse<{ items: MachineView[] }>>;
  /** 预注册机器，返回固定 machine id 与下发用的初始化命令 */
  create(body: { name: string; labels?: string[]; agentName?: string }): Promise<ApiResponse<MachineCreateResult>>;
  /** 更新机器展示信息（名称 / 标签 / 引擎） */
  update(
    machineId: string,
    body: { name?: string; labels?: string[]; agentName?: string },
  ): Promise<ApiResponse<MachineView>>;
  /** 删除机器；仅当机器离线且未被引用时后端才允许 */
  remove(machineId: string): Promise<ApiResponse<{ deleted: true }>>;
}

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
  machines: MachineView[];
  machinesLoading: boolean;
  canManage: boolean;
  isOwner: boolean;
  currentUserId: string | null;
  editingName: boolean;
  editName: string;
  updateNameLoading: boolean;
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
  onEditMachine: (machine: MachineView) => void;
  onDeleteMachine: (machine: MachineView) => void;
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
  machineDeleteTarget: MachineView | null;
  machineCreateResult: MachineCreateResult | null;
  machineForm: MachineFormState;
  createMachineLoading: boolean;
  updateMachineLoading: boolean;
  deleteMachineLoading: boolean;
  onMachineCreateOpenChange: (open: boolean) => void;
  onMachineEditOpenChange: (open: boolean) => void;
  onMachineDeleteTargetChange: (machine: MachineView | null) => void;
  onMachineFormChange: (form: MachineFormState) => void;
  onCreateMachine: () => void;
  onUpdateMachine: () => void;
  onDeleteMachine: () => void;
}
