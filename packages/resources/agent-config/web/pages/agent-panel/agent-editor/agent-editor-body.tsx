import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { cn } from "@fenix/ui-components/lib/cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fenix/ui-components/ui/alert-dialog";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fenix/ui-components/ui/tabs";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Check, Cpu, Database, Eye, Layers3, Loader2, RotateCcw, Server, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type FieldErrors, FormProvider, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { isAgentWritable } from "../../../lib/agent-resource-access";
import { isValidAgentNameInput } from "../../../lib/agent-utils";
import { AgentEditorHeader, AgentTemplatePanel } from "./AgentEditorChrome";
import { AgentEditorLoadingShell } from "./AgentEditorLoadingShell";
import { type AgentEditorSection, AgentEditorSections } from "./AgentEditorSections";
// 仅类型：容器（`AgentFormDialog.tsx`）决定「模态 / portal 工作区」并渲染本组件，
// 两端共用同一份属性契约，故 `import type` 反向引用容器（编译期擦除，无运行时环）。
import type { AgentFormDialogProps } from "./AgentFormDialog";
import {
  CONFIG_MAP,
  CONTENT,
  EDITOR_ROOT,
  ERROR_STATE,
  FOOTER,
  FOOTER_ACTIONS,
  FOOTER_STATE,
  MAP_BADGE,
  MAP_BADGE_MISSING,
  MAP_COPY,
  MAP_COPY_CAPTION,
  MAP_COPY_TITLE,
  MAP_ICON,
  MAP_LABEL,
  MAP_TABS_LIST,
  MAP_TRIGGER,
  NO_TEMPLATE_PANEL,
  NOTICE_BAR,
  WORKSPACE_TABS,
} from "./agent-editor-classes";
import {
  type AgentEditorValues,
  type AgentTemplate,
  agentEditorSchema,
  createAgentEditorDefaults,
  shouldConfirmAgentEditorClose,
  shouldDisableAgentEditor,
  shouldShowAgentEditorLoading,
} from "./agent-editor-model";
import { useAgentEditor } from "./use-agent-editor";

const SECTIONS: Array<{ id: AgentEditorSection; icon: typeof Sparkles }> = [
  { id: "identity", icon: Sparkles },
  { id: "model", icon: Cpu },
  { id: "capabilities", icon: Layers3 },
  { id: "knowledge", icon: Database },
  { id: "runtime", icon: Server },
  { id: "sharing", icon: Eye },
];

const FIELD_SECTIONS: Partial<Record<keyof AgentEditorValues, AgentEditorSection>> = {
  name: "identity",
  modelId: "model",
  skillIds: "capabilities",
  mcpIds: "capabilities",
  siteAppIds: "capabilities",
  knowledgeBaseIds: "knowledge",
  defaultNamespaces: "knowledge",
  maxResults: "knowledge",
  agentNode: "runtime",
  publicReadable: "sharing",
};

const FIELD_IDS: Partial<Record<keyof AgentEditorValues, string>> = {
  name: "agent-editor-name",
  modelId: "agent-editor-model-options",
  defaultNamespaces: "agent-editor-default-namespaces",
  maxResults: "agent-editor-max-results",
};

function firstInvalidField(errors: FieldErrors<AgentEditorValues>): keyof AgentEditorValues | undefined {
  return Object.keys(errors)[0] as keyof AgentEditorValues | undefined;
}

/**
 * 编辑器主体：配置地图（左）+ 分节表单（中）+ 模板面板（右）+ 页脚 + 两个确认弹窗。
 *
 * 从 `AgentFormDialog.tsx` 拆出（§4.7）：容器只管「用哪种壳渲染」（移动端 Sheet / 桌面 portal
 * 工作区）与打开时的焦点交接，本文件承担全部表单状态与保存流程。
 */
export function AgentEditorBody(
  props: AgentFormDialogProps & {
    mobile: boolean;
    registerCloseHandler: (handler: () => void) => void;
  },
) {
  const { t } = useTranslation(NS.AGENTS);
  // `restarting` / `restartConfirm` / `restartLater` / `configSavedRestart*` 随台账 D4 从宿主
  // `agentPanel` 字典迁入本包：`translatePanel` 与 `translate` 因此同源，保留两个绑定只为不改
  // `useAgentEditor` 的端口形状。
  const { t: tp } = useTranslation(NS.AGENTS);
  const { mobile } = props;
  const [activeSection, setActiveSection] = useState<AgentEditorSection>("identity");
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const initializedEditorKeyRef = useRef<string | null>(null);
  const editor = useAgentEditor({ ...props, translate: t, translatePanel: tp });
  const form = useForm<AgentEditorValues>({
    resolver: zodResolver(agentEditorSchema),
    defaultValues: createAgentEditorDefaults(props.mode === "create" ? props.defaultName : props.agentName),
  });

  const editorKey = `${props.mode}:${props.mode === "edit" ? props.agentName : (props.defaultName ?? "")}`;
  useEffect(() => {
    if (!editor.data || initializedEditorKeyRef.current === editorKey) return;
    initializedEditorKeyRef.current = editorKey;
    form.reset(editor.data.initialValues);
  }, [editor.data, editorKey, form]);
  useEffect(() => {
    if (!props.open) {
      initializedEditorKeyRef.current = null;
      setActiveSection("identity");
    }
  }, [props.open]);

  const values = form.watch();
  const readOnly =
    props.mode === "edit" && editor.data
      ? !isAgentWritable({ name: props.agentName, scope: editor.data.scope, access: editor.data.access })
      : false;
  const title = readOnly
    ? t("dialog.detailTitle")
    : props.mode === "edit"
      ? t("dialog.editTitle")
      : t("dialog.createTitle");
  const requestClose = useCallback(
    () =>
      shouldConfirmAgentEditorClose(form.formState.isDirty, readOnly)
        ? setCloseConfirmOpen(true)
        : props.onOpenChange(false),
    [form.formState.isDirty, props.onOpenChange, readOnly],
  );
  useEffect(() => props.registerCloseHandler(requestClose), [props.registerCloseHandler, requestClose]);
  const submit = form.handleSubmit(
    async (next) => {
      if (props.mode === "create" && !isValidAgentNameInput(next.name.trim())) {
        form.setError("name", { message: "invalid" });
        setActiveSection("identity");
        toast.warning(t("editor.validationSummary"));
        requestAnimationFrame(() => document.getElementById("agent-editor-name")?.focus());
        return;
      }
      await editor.save(next);
      if (props.mode === "edit") form.reset(next);
    },
    (errors) => {
      const field = firstInvalidField(errors);
      toast.warning(t("editor.validationSummary"));
      if (!field) return;
      setActiveSection(FIELD_SECTIONS[field] ?? "identity");
      requestAnimationFrame(() => {
        const target = FIELD_IDS[field]
          ? document.getElementById(FIELD_IDS[field]!)
          : document.querySelector<HTMLElement>(`[name="${field}"]`);
        target?.focus();
      });
    },
  );
  /** 应用模板：替换 Prompt 与 Skills，创建态另替换名称。面板常驻，应用后就地更新表单并靠页脚草稿态提示。 */
  const applyTemplate = (template: AgentTemplate) => {
    form.setValue("prompt", template.prompt, { shouldDirty: true });
    if (props.mode === "create") form.setValue("name", template.name, { shouldDirty: true });
    const ids = template.skills
      .map((name) => editor.data?.skills.find((skill) => skill.label === name || skill.label.endsWith(`/${name}`))?.id)
      .filter((id): id is string => !!id);
    form.setValue("skillIds", ids, { shouldDirty: true });
  };
  useEffect(() => {
    if (!props.open) return;
    const saveShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "s") {
        event.preventDefault();
        if (!readOnly && !editor.saving && editor.data) void submit();
      }
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [editor.data, editor.saving, props.open, readOnly, submit]);

  if (shouldShowAgentEditorLoading(editor.loading, !!editor.data, !!editor.loadError))
    return (
      <AgentEditorLoadingShell
        mode={props.mode}
        name={props.mode === "create" ? (props.defaultName ?? "") : props.agentName}
        onClose={requestClose}
      />
    );
  if (editor.loadError)
    // 读取失败态走库内统一状态块（§4.1「空态 / 失败 / 无权限刻意共用一个骨架」）：图标、标题、
    // 说明、重试按钮的排版与配色都由 `EmptyState` 决定，本处只传文案与 `role="alert"`。
    // `ERROR_STATE` 保留为容器定位类（撑满 + 居中）；原来给标题/说明补字号的伴随 CSS 规则随之下沉删除。
    // `loadError.message` 自本批起**只可能是字典文案**：三个来源分别是 `editor.loadFailedHint`
    // （`use-agent-editor` 的取数失败，原始 `ApiError` 已收敛在那一侧进日志）、`editor.missingTarget`
    // 与 `editor.loadRequired`，不再有后端信封原文（§9.3）。
    return (
      <EmptyState
        role="alert"
        className={ERROR_STATE}
        tone="danger"
        icon={<AlertTriangle />}
        title={t("editor.loadFailed")}
        description={editor.loadError.message}
        action={{ label: t("editor.retry"), onClick: editor.retry }}
      />
    );
  if (!editor.data) return null;
  const data = editor.data;
  /** 模板面板是否占据工作区右列：只读态与无模板都不渲染（工作区随之回落两列，见 `NO_TEMPLATE_PANEL`）。 */
  const showTemplate = !readOnly && data.templates.length > 0;
  /** 配置地图条目的状态徽标。`missing` 的两类缺失态（待完善 / 未配置）在渲染时标红，提示补全该分区；
   * 其余状态（完整 / 已配置 / 数字计数 / 组织内 / 仅团队 / 默认）沿用中性徽标。 */
  const filled = (label: string) => ({ label, missing: false });
  const missing = (label: string) => ({ label, missing: true });
  const getSectionStatus = (section: AgentEditorSection) => {
    if (section === "identity") return values.name ? filled(t("editor.complete")) : missing(t("editor.incomplete"));
    if (section === "model")
      return values.modelId ? filled(t("editor.configured")) : missing(t("editor.notConfigured"));
    if (section === "capabilities")
      return filled(String(values.skillIds.length + values.mcpIds.length + values.siteAppIds.length));
    if (section === "knowledge") return filled(String(values.knowledgeBaseIds.length));
    if (section === "runtime") return filled(t("editor.configured"));
    if (section === "sharing")
      return filled(values.publicReadable ? t("editor.organizationVisible") : t("editor.teamOnly"));
    const hasExtra = !!values.extra.trim() && values.extra.trim() !== "{}";
    return filled(hasExtra ? t("editor.configured") : t("editor.defaultStatus"));
  };

  return (
    <FormProvider {...form}>
      <form className={EDITOR_ROOT} onSubmit={submit} aria-busy={editor.loading || editor.saving || editor.restarting}>
        <fieldset disabled={shouldDisableAgentEditor(editor.saving, editor.restarting)} className="contents">
          {data.resourceErrors.length > 0 && (
            // 源里 background/color 引用未定义 token（--color-warning），实际不生效，故只迁有效声明。
            <div className={NOTICE_BAR} role="alert">
              {t("editor.optionalResourcesFailed", { resources: data.resourceErrors.join(", ") })}
            </div>
          )}
          <AgentEditorHeader
            title={title}
            name={values.name}
            agentId={props.mode === "edit" ? data.agentId : null}
            readOnly={readOnly}
            onClose={requestClose}
          />
          {readOnly && (
            <div className={`${NOTICE_BAR} bg-surface-2 text-text-muted`}>
              {t("resource.readOnlyAgent", { source: data.organizationName ?? values.name })}
            </div>
          )}
          <Tabs
            value={activeSection}
            onValueChange={(value) => setActiveSection(value as AgentEditorSection)}
            orientation={mobile ? "horizontal" : "vertical"}
            className={cn(WORKSPACE_TABS, !showTemplate && NO_TEMPLATE_PANEL)}
          >
            <nav className={CONFIG_MAP} aria-label={t("editor.configurationMap")}>
              <span className={MAP_LABEL} data-slot="editor-map-label">
                {t("editor.configurationMap")}
              </span>
              <TabsList variant="line" className={MAP_TABS_LIST}>
                {SECTIONS.map(({ id, icon: Icon }) => {
                  const sectionStatus = getSectionStatus(id);
                  return (
                    <TabsTrigger key={id} value={id} className={MAP_TRIGGER}>
                      <span className={MAP_ICON}>
                        <Icon className="w-3.5" />
                      </span>
                      <span className={MAP_COPY} data-slot="editor-map-copy">
                        <strong className={MAP_COPY_TITLE} data-slot="editor-map-copy-title">
                          {t(`editor.sections.${id}`)}
                        </strong>
                        <small className={MAP_COPY_CAPTION} data-slot="editor-map-copy-caption">
                          {t(`editor.sectionCaptions.${id}`)}
                        </small>
                      </span>
                      <Badge variant="secondary" className={cn(MAP_BADGE, sectionStatus.missing && MAP_BADGE_MISSING)}>
                        {sectionStatus.label}
                      </Badge>
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </nav>
            <main className={CONTENT}>
              {SECTIONS.map(({ id }) => (
                <TabsContent key={id} value={id} className="h-full">
                  <AgentEditorSections
                    section={id}
                    form={form}
                    data={data}
                    mode={props.mode}
                    readOnly={readOnly}
                    onCopyAgentId={() =>
                      data?.agentId &&
                      navigator.clipboard
                        .writeText(data.agentId)
                        .then(() => toast.success(t("editor.copySuccess")))
                        .catch(() => toast.error(t("editor.copyFailed")))
                    }
                  />
                </TabsContent>
              ))}
            </main>
            {showTemplate && <AgentTemplatePanel templates={data.templates} onApply={applyTemplate} />}
          </Tabs>
          <footer className={FOOTER}>
            <div className={FOOTER_STATE} data-slot="editor-footer-state">
              <span
                className="grid size-7 flex-none basis-7 place-items-center rounded-md bg-indigo-50 text-xs text-blue-800"
                data-slot="editor-footer-state-count"
              >
                {form.formState.isDirty ? "1" : <Check />}
              </span>
              <p className="m-0 flex flex-col gap-0.5">
                <strong className="text-xs text-slate-700" data-slot="editor-footer-state-title">
                  {form.formState.isDirty ? t("editor.unsaved") : t("editor.savedState")}
                </strong>
                <small className="text-3xs text-gray-400" data-slot="editor-footer-state-caption">
                  {t("editor.draftStatus")}
                </small>
              </p>
            </div>
            {!readOnly && form.formState.isDirty && (
              // design 层 `.agent-editor-root .agent-editor-reset`：灰字 + 透明底。
              <Button
                className="!bg-transparent !text-slate-400"
                type="button"
                variant="ghost"
                onClick={() => form.reset()}
                disabled={editor.loading || editor.saving}
              >
                <RotateCcw />
                {t("editor.reset")}
              </Button>
            )}
            <div className={FOOTER_ACTIONS}>
              <Button type="button" variant="outline" onClick={requestClose}>
                {readOnly ? t("editor.close") : t("dialog.cancel")}
              </Button>
              {!readOnly && (
                <Button
                  // design 层 `.agent-editor-footer__actions .is-primary`：品牌底 + 127px 最小宽度 + 投影。
                  className="agent-form-dialog-submit !min-w-31.75 !border-blue-600 !bg-blue-600 !text-white"
                  type="submit"
                  disabled={editor.loading || editor.saving || !!editor.loadError}
                >
                  {editor.saving && <Loader2 className="animate-spin" />}
                  {props.mode === "create" ? t("dialog.createConfirm") : t("actions.save")}
                </Button>
              )}
            </div>
          </footer>
        </fieldset>
      </form>
      <AlertDialog open={closeConfirmOpen} onOpenChange={setCloseConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("editor.discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("editor.discardDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("editor.continueEditing")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => props.onOpenChange(false)}>{t("editor.discard")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={editor.restartDialogOpen} onOpenChange={editor.setRestartDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tp("configSavedRestartTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{tp("configSavedRestartDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => props.onOpenChange(false)}>{tp("restartLater")}</AlertDialogCancel>
            <AlertDialogAction disabled={editor.restarting} onClick={() => editor.restart()}>
              {editor.restarting ? tp("restarting") : tp("restartConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FormProvider>
  );
}
