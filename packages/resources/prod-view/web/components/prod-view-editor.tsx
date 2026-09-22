/**
 * prod-view-editor.tsx —「生产视图（ProdView）」编辑器的包内共享实现。
 *
 * 面板外壳（`pages/agent-panel/ProdViewsPanel.tsx`）与整页外壳（`pages/agent-panel/pages/AgentProdViewsPage.tsx`）
 * 各写过一份逐字同构的编辑器：模块开关区、创建/编辑弹窗的表单状态与提交、复制链接 / 打开视图、删除确认。
 * 两处只差两点——i18n 键前缀（`panel.*` vs 裸键）与 agent 的来源——其余连 class 名都逐字相同，
 * 任何一侧改动都要手工同步另一侧（漂移已在别处发生过：`handleSubmit` 的 agent 校验位置就不同）。
 * 故在此收口，两个外壳只留列表与外壳差异（面板的卡片列表 / 整页的 `AgentCardList`、头部动作位置）。
 *
 * 文案的传法：**键名不在这里统一**。两个入口的措辞本就不同（「创建发布视图」vs「创建 ProdView」），
 * 统一成一套键会改掉其中一个入口的文案，也会让 i18n 契约测试（`web/__tests__/prod-view-i18n.test.ts`
 * 对源码做正则扫描、连注释里的字面量键都算数）失去覆盖。因此本模块只接收调用方用**自己的键**翻译好的
 * 字符串，内部唯一的动态键是模块名 `modules.${moduleKey}`——两个外壳同源，本模块自己就能解析
 * （动态键不被扫描覆盖，故此处不写任何字面量的取词调用，避免注释再被正则误判成真实用键）。
 *
 * agent 的来源：面板外壳的 agent 由 props 固定（`boundAgentId`），弹窗里没有绑定控件；整页外壳在弹窗里选
 * （`formAgentId`）。两者只有**创建**时用得到——update 不带 agentId，绑定关系不随编辑改变，
 * 所以「未绑定 agent」的校验落在创建分支，且只有整页外壳会看到提示（面板的创建入口已被禁用）。
 *
 * 不上移到 `@fenix/ui-components`：当前只有本包这两个外壳消费，上移会形成无人使用的公共面。
 */

import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Switch } from "@fenix/ui-components/ui/switch";
import { unwrap } from "@fenix/web-runtime/api/request";
import { Copy, ExternalLink } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type ProdViewInfo, prodViewApi } from "../api/prod-views";
import { PROD_VIEWS_NS } from "../i18n/namespace";
import { buildEnabledMap, buildModulesConfig, defaultEnabledMap, PANEL_MODULE_KEYS } from "../lib/prod-view-modules";

// ── 模块配置开关区 ──

export interface ModuleConfigSectionProps {
  enabledMap: Record<string, boolean>;
  onToggle: (key: string, checked: boolean) => void;
  /** 区域标题：两个外壳的键不同（`panel.moduleSection` / `modulePanelSection`），由调用方翻译后传入 */
  label: string;
}

/** 模块配置开关区域（创建 & 编辑共用）。 */
export function ModuleConfigSection({ enabledMap, onToggle, label }: ModuleConfigSectionProps) {
  // 模块名的键组（`modules.*`）也归本包 prodViews 命名空间，与外壳文案同源，故只需一次 useTranslation。
  const { t } = useTranslation(PROD_VIEWS_NS);

  const ModuleRow = ({ moduleKey }: { moduleKey: string }) => (
    <div className="flex items-center justify-between rounded bg-gray-50 px-3 py-2">
      <span className="text-sm">{t(`modules.${moduleKey}`)}</span>
      <Switch checked={enabledMap[moduleKey]} onCheckedChange={(checked) => onToggle(moduleKey, checked)} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-text-secondary">{label}</Label>
        <div className="grid grid-cols-2 gap-2">
          {PANEL_MODULE_KEYS.map((mk) => (
            <ModuleRow key={mk} moduleKey={mk} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 创建 / 编辑共用的表单状态与提交 ──

/** 表单状态与动作；沿用两个外壳原有的字段名，便于对照。 */
export interface ProdViewEditor {
  dialogOpen: boolean;
  editingView: ProdViewInfo | null;
  isEditing: boolean;
  formName: string;
  setFormName: (name: string) => void;
  formDesc: string;
  setFormDesc: (desc: string) => void;
  /** 弹窗内的 agent 绑定（整页外壳）；面板外壳由 `boundAgentId` 固定，该字段不被读取 */
  formAgentId: string;
  setFormAgentId: (agentId: string) => void;
  formModules: Record<string, boolean>;
  setFormModules: (modules: Record<string, boolean>) => void;
  submitting: boolean;
  /** 打开创建弹窗；`initialName` 供外壳预填（面板填当前 agent 名，整页留空由选择器决定） */
  openCreate: (initialName?: string) => void;
  openEdit: (view: ProdViewInfo) => void;
  closeDialog: () => void;
  handleSubmit: () => Promise<void>;
}

export interface UseProdViewEditorOptions {
  /** 创建时固定的 agent（面板外壳来自 props）；为空表示 agent 由弹窗里的 `formAgentId` 决定（整页外壳） */
  boundAgentId?: string | null;
  /** 成功提示与「未选 agent」提示：键随外壳不同，故传译文 */
  messages: {
    createSuccess: string;
    updateSuccess: string;
    /** 只有整页外壳需要：面板外壳的创建入口在 `!agentId` 时已禁用，走不到这里 */
    agentRequired?: string;
  };
  /** 保存成功后的列表刷新：两个外壳的列表口径不同（面板按 agentId 过滤），不上升为共享职责 */
  onSaved: () => void;
}

export function useProdViewEditor({ boundAgentId, messages, onSaved }: UseProdViewEditorOptions): ProdViewEditor {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingView, setEditingView] = useState<ProdViewInfo | null>(null);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formAgentId, setFormAgentId] = useState("");
  // 惰性初始化：默认模块集合由 lib 现算，没必要每次渲染都构造一遍
  const [formModules, setFormModules] = useState<Record<string, boolean>>(defaultEnabledMap);
  const [submitting, setSubmitting] = useState(false);

  const isEditing = !!editingView;

  const openCreate = (initialName = "") => {
    setEditingView(null);
    setFormName(initialName);
    setFormDesc("");
    setFormAgentId("");
    setFormModules(defaultEnabledMap());
    setDialogOpen(true);
  };

  const openEdit = (view: ProdViewInfo) => {
    setEditingView(view);
    setFormName(view.name);
    setFormDesc(view.description ?? "");
    // 面板外壳没有 agent 控件、创建时也不读 formAgentId，这里照样写入：两个外壳共用一条状态路径，
    // 比按外壳分支更不容易漏（面板侧该字段始终不被读取）。
    setFormAgentId(view.agentId);
    setFormModules(buildEnabledMap(view.modulesConfig));
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingView(null);
  };

  const handleSubmit = async () => {
    if (!formName.trim()) return;
    setSubmitting(true);
    try {
      const existingModulesConfig = editingView?.modulesConfig;
      if (editingView) {
        // update 不带 agentId：绑定关系只在创建时确定，编辑只改名称 / 描述 / 模块配置。
        await unwrap(
          prodViewApi.update(editingView.id, {
            name: formName.trim(),
            description: formDesc.trim() || undefined,
            modulesConfig: buildModulesConfig(existingModulesConfig, formModules),
          }),
        );
        toast.success(messages.updateSuccess);
      } else {
        const agentId = boundAgentId ?? formAgentId;
        if (!agentId) {
          // 面板外壳的创建入口在 `!agentId` 时已禁用，因此这句提示实际只对整页外壳可见。
          if (messages.agentRequired) toast.error(messages.agentRequired);
          setSubmitting(false);
          return;
        }
        await unwrap(
          prodViewApi.create({
            name: formName.trim(),
            agentId,
            description: formDesc.trim() || undefined,
            modulesConfig: buildModulesConfig(existingModulesConfig, formModules),
          }),
        );
        toast.success(messages.createSuccess);
      }
      closeDialog();
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return {
    dialogOpen,
    editingView,
    isEditing,
    formName,
    setFormName,
    formDesc,
    setFormDesc,
    formAgentId,
    setFormAgentId,
    formModules,
    setFormModules,
    submitting,
    openCreate,
    openEdit,
    closeDialog,
    handleSubmit,
  };
}

// ── 创建 / 编辑弹窗 ──

/** 弹窗文案：每个字段都由调用方用**自己的键**翻译，避免两个入口的措辞互相覆盖。 */
export interface ProdViewEditorLabels {
  /** 编辑态标题按 `${editTitle} — ${名称}` 组合，与创建态共用同一套弹窗结构 */
  editTitle: string;
  createTitle: string;
  linkLabel: string;
  nameLabel: string;
  namePlaceholder: string;
  descLabel: string;
  descPlaceholder: string;
  modulesLabel: string;
  /** 模块开关区标题 */
  moduleSection: string;
  /** 链接行两个图标按钮的可访问名（可见文本为空，只能靠 aria-label 命名） */
  copyLink: string;
  openView: string;
  cancel: string;
  save: string;
}

export interface ProdViewFormDialogProps {
  editor: ProdViewEditor;
  labels: ProdViewEditorLabels;
  onCopyLink: (id: string) => void;
  onOpenView: (id: string) => void;
  /** 仅创建态渲染的 agent 绑定区（整页外壳有选择器；面板的 agent 由外壳固定，不传即不渲染） */
  agentField?: ReactNode;
}

/** 创建 / 编辑共用弹窗：结构与 class 与原两份实现逐字一致，只有文案与 agent 绑定区来自 props。 */
export function ProdViewFormDialog({ editor, labels, onCopyLink, onOpenView, agentField }: ProdViewFormDialogProps) {
  const {
    dialogOpen,
    editingView,
    isEditing,
    formName,
    setFormName,
    formDesc,
    setFormDesc,
    formModules,
    setFormModules,
    submitting,
    closeDialog,
    handleSubmit,
  } = editor;

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => {
        if (!open) closeDialog();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? `${labels.editTitle} — ${editingView?.name}` : labels.createTitle}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {/* 编辑时显示链接 */}
          {isEditing && editingView && (
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <span>{labels.linkLabel}:</span>
              <code className="text-brand">{`${window.location.origin}/view/${editingView.id}`}</code>
              <Button size="xs" variant="ghost" onClick={() => onCopyLink(editingView.id)} aria-label={labels.copyLink}>
                <Copy className="h-3 w-3" />
              </Button>
              <Button size="xs" variant="ghost" onClick={() => onOpenView(editingView.id)} aria-label={labels.openView}>
                <ExternalLink className="h-3 w-3" />
              </Button>
            </div>
          )}
          {/* 名称 */}
          <div className="space-y-2">
            <Label>{labels.nameLabel}</Label>
            <Input
              placeholder={labels.namePlaceholder}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
          </div>
          {/* 描述 */}
          <div className="space-y-2">
            <Label>{labels.descLabel}</Label>
            <Input
              placeholder={labels.descPlaceholder}
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
            />
          </div>
          {/* Agent 绑定（仅创建时） */}
          {!isEditing && agentField}
          {/* 模块配置 */}
          <div className="space-y-1">
            <Label className="text-sm">{labels.modulesLabel}</Label>
            <ModuleConfigSection
              enabledMap={formModules}
              onToggle={(key, checked) => setFormModules({ ...formModules, [key]: checked })}
              label={labels.moduleSection}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog}>
            {labels.cancel}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !formName.trim()}>
            {submitting ? "..." : labels.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── 删除确认 ──

export interface ProdViewDeleteState {
  target: ProdViewInfo | null;
  /** 行内删除按钮的入口：登记待确认对象，确认框随之打开 */
  request: (view: ProdViewInfo) => void;
  cancel: () => void;
  confirm: () => void;
}

export interface UseProdViewDeleteOptions {
  /** 删除成功的提示：键随外壳不同，故传译文 */
  successMessage: string;
  /** 删除成功后的列表刷新 */
  onDeleted: () => void;
}

/** 删除确认的状态与请求（弹窗本体见 `ProdViewDeleteDialog`）。 */
export function useProdViewDelete({ successMessage, onDeleted }: UseProdViewDeleteOptions): ProdViewDeleteState {
  const [target, setTarget] = useState<ProdViewInfo | null>(null);

  const cancel = () => setTarget(null);

  const confirm = async () => {
    const view = target;
    // 先关确认框再发请求：与原实现一致（触发后立即置空），弹窗不等待请求往返；
    // 失败只弹 toast、不刷新列表，删除入口保持原样可重试。
    setTarget(null);
    if (!view) return;
    try {
      await unwrap(prodViewApi.del(view.id));
      toast.success(successMessage);
      onDeleted();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return { target, request: (view) => setTarget(view), cancel, confirm };
}

export interface ProdViewDeleteDialogProps {
  state: ProdViewDeleteState;
  /** 确认框标题与描述（描述已由调用方按 `{{name}}` 插值翻译好） */
  title: string;
  description: string;
}

export function ProdViewDeleteDialog({ state, title, description }: ProdViewDeleteDialogProps) {
  return (
    <ConfirmDialog
      open={!!state.target}
      onOpenChange={(open) => {
        if (!open) state.cancel();
      }}
      title={title}
      description={description}
      variant="destructive"
      onConfirm={state.confirm}
    />
  );
}

// ── 链接动作 ──

/**
 * 复制公开视图链接。剪贴板写入是异步的，且非安全上下文（http / 无权限）会直接拒绝，
 * 因此失败分支必须给出提示而不是静默吞掉。
 */
export function copyProdViewLink(id: string, messages: { copied: string; failed: string }) {
  const url = `${window.location.origin}/view/${id}`;
  navigator.clipboard.writeText(url).then(
    () => toast.success(messages.copied),
    () => toast.error(messages.failed),
  );
}

/** 在新标签页打开公开视图。 */
export function openProdView(id: string) {
  window.open(`/view/${id}`, "_blank");
}
