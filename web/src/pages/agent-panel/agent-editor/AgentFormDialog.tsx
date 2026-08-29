import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Check, Cpu, Database, Eye, Layers3, Loader2, RotateCcw, Server, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type FieldErrors, FormProvider, useForm } from "react-hook-form";
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
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NS } from "../../../i18n";
import { isAgentWritable } from "../../../lib/agent-resource-access";
import { isValidAgentNameInput } from "../../../lib/agent-utils";
import { AgentEditorHeader, AgentEditorSummary, AgentTemplatePicker } from "./AgentEditorChrome";
import { AgentEditorLoadingShell } from "./AgentEditorLoadingShell";
import { type AgentEditorSection, AgentEditorSections } from "./AgentEditorSections";
import {
  type AgentEditorValues,
  type AgentTemplate,
  agentEditorSchema,
  createAgentEditorDefaults,
  shouldConfirmAgentEditorClose,
  shouldShowAgentEditorLoading,
} from "./agent-editor-model";
import { useAgentEditor } from "./use-agent-editor";
import "./agent-editor.css";
import "./agent-editor-design.css";
import "./agent-editor-responsive.css";
import "./agent-editor-form-fields.css";
import "./agent-editor-form-surfaces.css";
import "./agent-editor-library.css";
import "./agent-editor-knowledge.css";
import "./agent-editor-loading.css";
import "./agent-editor-form-responsive.css";

export type AgentFormDialogProps =
  | {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      mode: "create";
      defaultName?: string;
      onSuccess?: (id?: string) => void;
      portalContainer?: HTMLElement | null;
    }
  | {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      mode: "edit";
      agentName: string;
      portalContainer?: HTMLElement | null;
      onSuccess?: never;
      defaultName?: never;
    };

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
  defaultNamespaces: "agent-editor-default-namespaces",
  maxResults: "agent-editor-max-results",
};

function firstInvalidField(errors: FieldErrors<AgentEditorValues>): keyof AgentEditorValues | undefined {
  return Object.keys(errors)[0] as keyof AgentEditorValues | undefined;
}

function useMobileEditor(open: boolean) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (!open) return;
    const query = window.matchMedia("(max-width: 759px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [open]);
  return mobile;
}

function AgentEditorBody(
  props: AgentFormDialogProps & {
    mobile: boolean;
    registerCloseHandler: (handler: () => void) => void;
  },
) {
  const { t } = useTranslation(NS.AGENTS);
  const { t: tp } = useTranslation(NS.AGENT_PANEL);
  const { mobile } = props;
  const [activeSection, setActiveSection] = useState<AgentEditorSection>("identity");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [validationSummary, setValidationSummary] = useState("");
  const templateTriggerRef = useRef<HTMLButtonElement>(null);
  const editor = useAgentEditor({ ...props, translate: t, translatePanel: tp });
  const form = useForm<AgentEditorValues>({
    resolver: zodResolver(agentEditorSchema),
    defaultValues: createAgentEditorDefaults(props.mode === "create" ? props.defaultName : props.agentName),
  });

  useEffect(() => {
    if (editor.data) form.reset(editor.data.initialValues);
  }, [editor.data, form]);
  useEffect(() => {
    if (!props.open) {
      setActiveSection("identity");
      setTemplateOpen(false);
    }
  }, [props.open]);

  const values = form.watch();
  const readOnly =
    props.mode === "edit" && editor.data
      ? !isAgentWritable({ name: props.agentName, resourceAccess: editor.data.resourceAccess })
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
        setValidationSummary(t("editor.validationSummary"));
        requestAnimationFrame(() => document.getElementById("agent-editor-name")?.focus());
        return;
      }
      await editor.save(next);
      if (props.mode === "edit") form.reset(next);
      setValidationSummary("");
    },
    (errors) => {
      const field = firstInvalidField(errors);
      setValidationSummary(t("editor.validationSummary"));
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
  const applyTemplate = (template: AgentTemplate) => {
    form.setValue("prompt", template.prompt, { shouldDirty: true });
    if (props.mode === "create") form.setValue("name", template.name, { shouldDirty: true });
    const ids = template.skills
      .map((name) => editor.data?.skills.find((skill) => skill.label === name || skill.label.endsWith(`/${name}`))?.id)
      .filter((id): id is string => !!id);
    form.setValue("skillIds", ids, { shouldDirty: true });
    setTemplateOpen(false);
    requestAnimationFrame(() => templateTriggerRef.current?.focus());
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
    return (
      <div className="agent-editor-state" role="alert">
        <AlertTriangle className="size-6 text-destructive" />
        <strong>{t("editor.loadFailed")}</strong>
        <p>{editor.loadError.message}</p>
        <Button type="button" onClick={editor.retry}>
          {t("editor.retry")}
        </Button>
      </div>
    );
  if (!editor.data) return null;
  const data = editor.data;
  const getSectionStatus = (section: AgentEditorSection): string => {
    if (section === "identity") return values.name ? t("editor.complete") : t("editor.incomplete");
    if (section === "model") return values.modelId ? t("editor.configured") : t("editor.notConfigured");
    if (section === "capabilities")
      return String(values.skillIds.length + values.mcpIds.length + values.siteAppIds.length);
    if (section === "knowledge") return String(values.knowledgeBaseIds.length);
    if (section === "runtime") return t("editor.configured");
    if (section === "sharing") return values.publicReadable ? t("editor.organizationVisible") : t("editor.teamOnly");
    return values.extra.trim() && values.extra.trim() !== "{}" ? t("editor.configured") : t("editor.defaultStatus");
  };

  return (
    <FormProvider {...form}>
      <form
        className="agent-editor-root"
        onSubmit={submit}
        aria-busy={editor.loading || editor.saving || editor.restarting}
      >
        <fieldset disabled={editor.loading || editor.saving || editor.restarting} className="contents">
          {data.resourceErrors.length > 0 && (
            <div className="agent-editor-resource-error" role="alert">
              {t("editor.optionalResourcesFailed", { resources: data.resourceErrors.join(", ") })}
            </div>
          )}
          {validationSummary && (
            <div className="agent-editor-validation-summary" role="alert" aria-live="assertive">
              {validationSummary}
            </div>
          )}
          <AgentEditorHeader
            title={title}
            name={values.name}
            agentId={props.mode === "edit" ? data.agentId : null}
            readOnly={readOnly}
            showTemplate={!readOnly && data.templates.length > 0}
            templateTriggerRef={templateTriggerRef}
            onTemplate={() => setTemplateOpen(true)}
            onClose={requestClose}
          />
          {readOnly && (
            <div className="agent-editor-readonly">
              {t("resource.readOnlyAgent", { source: data.resourceAccess?.sourceOrganizationName ?? values.name })}
            </div>
          )}
          <Tabs
            value={activeSection}
            onValueChange={(value) => setActiveSection(value as AgentEditorSection)}
            orientation={mobile ? "horizontal" : "vertical"}
            className="agent-editor-workspace"
          >
            <nav className="agent-editor-map" aria-label={t("editor.configurationMap")}>
              <span className="agent-editor-map-label">{t("editor.configurationMap")}</span>
              <TabsList variant="line">
                {SECTIONS.map(({ id, icon: Icon }) => (
                  <TabsTrigger key={id} value={id}>
                    <span className="agent-editor-map-icon">
                      <Icon />
                    </span>
                    <span className="agent-editor-map-copy">
                      <strong>{t(`editor.sections.${id}`)}</strong>
                      <small>{t(`editor.sectionCaptions.${id}`)}</small>
                    </span>
                    <em>{getSectionStatus(id)}</em>
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="agent-editor-readiness">
                <div>
                  <span>{t("editor.publishCheck")}</span>
                  <strong>6 / 6</strong>
                </div>
                <i>
                  <span />
                </i>
                <p>
                  <Check />
                  {t("editor.configurationReady")}
                </p>
              </div>
            </nav>
            <main className="agent-editor-content">
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
            <AgentEditorSummary values={values} data={data} onSectionChange={setActiveSection} />
          </Tabs>
          <footer className="agent-editor-footer">
            <div className="agent-editor-footer__state">
              <span>{form.formState.isDirty ? "1" : <Check />}</span>
              <p>
                <strong>{form.formState.isDirty ? t("editor.unsaved") : t("editor.savedState")}</strong>
                <small>{t("editor.draftStatus")}</small>
              </p>
            </div>
            {!readOnly && form.formState.isDirty && (
              <Button
                className="agent-editor-reset"
                type="button"
                variant="ghost"
                onClick={() => form.reset()}
                disabled={editor.loading || editor.saving}
              >
                <RotateCcw />
                {t("editor.reset")}
              </Button>
            )}
            <div className="agent-editor-footer__actions">
              <Button type="button" variant="outline" onClick={requestClose}>
                {readOnly ? t("editor.close") : t("dialog.cancel")}
              </Button>
              {!readOnly && (
                <Button
                  className="is-primary"
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
      {templateOpen && (
        <AgentTemplatePicker
          templates={data.templates}
          onApply={applyTemplate}
          onClose={() => {
            setTemplateOpen(false);
            requestAnimationFrame(() => templateTriggerRef.current?.focus());
          }}
        />
      )}
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

/** 创建与移动端使用模态容器；桌面编辑是局部 portal 中的非模态工作区。 */
export function AgentFormDialog(props: AgentFormDialogProps) {
  const { t } = useTranslation(NS.AGENTS);
  const mobile = useMobileEditor(props.open);
  const closeHandlerRef = useRef<() => void>(() => props.onOpenChange(false));
  const openerRef = useRef<HTMLElement | null>(null);
  const registerCloseHandler = useCallback((handler: () => void) => {
    closeHandlerRef.current = handler;
  }, []);

  useEffect(() => {
    if (props.open) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!mobile) {
        requestAnimationFrame(() => document.querySelector<HTMLElement>(".agent-editor-panel[role='dialog']")?.focus());
      }
    } else {
      openerRef.current?.focus();
    }
  }, [mobile, props.open]);

  if (mobile)
    return (
      <Sheet
        open={props.open}
        modal
        onOpenChange={(open) => (open ? props.onOpenChange(true) : closeHandlerRef.current())}
      >
        <SheetContent
          portalContainer={undefined}
          showOverlay={false}
          showCloseButton={false}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            closeHandlerRef.current();
          }}
          className="agent-editor-shell agent-editor-panel agent-editor-mobile"
        >
          <SheetTitle className="sr-only">
            {props.mode === "create" ? t("dialog.createTitle") : t("dialog.editTitle")}
          </SheetTitle>
          <SheetDescription className="sr-only">{t("editor.dialogDescription")}</SheetDescription>
          <AgentEditorBody {...props} mobile registerCloseHandler={registerCloseHandler} />
        </SheetContent>
      </Sheet>
    );

  if (!props.open || typeof document === "undefined") return null;
  const host = props.portalContainer ?? document.body;
  const dialogTitle = props.mode === "create" ? t("dialog.createTitle") : t("dialog.editTitle");
  return createPortal(
    <section
      className="agent-editor-shell agent-editor-panel"
      role="dialog"
      aria-modal="false"
      tabIndex={-1}
      aria-label={dialogTitle}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          closeHandlerRef.current();
        }
      }}
    >
      <AgentEditorBody {...props} mobile={false} registerCloseHandler={registerCloseHandler} />
    </section>,
    host,
  );
}
