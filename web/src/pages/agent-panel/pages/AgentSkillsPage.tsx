import { useRequest } from "ahooks";
import { type ChangeEvent, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { MetaAgentPanel } from "@/components/MetaAgentPanel";
import { unwrap } from "@/src/api/request";
import { skillConfigApi } from "@/src/api/skills";
import { useMetaAgent } from "@/src/hooks/useMetaAgent";
import { NS } from "../../../i18n";
import { dispatchConfigChange } from "../../../lib/config-events";
import {
  canManageSkillSharing,
  canWriteSkill,
  getSkillKey,
  getSkillLookupKey,
} from "../../../lib/skill-resource-access";
import { buildSkillUploadFormData, parseSkillUploadFiles, validateUploadBatch } from "../../../lib/skill-upload";
import type {
  SkillUploadConflictResponse,
  SkillUploadConflictStrategy,
  UploadSkillSummary,
} from "../../../types/config";
import { AgentSkillsCatalog } from "./agent-skills-catalog";
import { AgentSkillsDialogs } from "./agent-skills-dialogs";
import type { SkillCatalogScope, SkillCreateMode, SkillInfo } from "./agent-skills-types";
import { getSkillFormValidationError } from "./agent-skills-utils";

type SkillUploadResult = { imported: unknown[]; skipped: unknown[] };

function normalizeSkillUploadResult(response: unknown): SkillUploadResult {
  const data = response as Partial<SkillUploadResult> | null;
  return {
    imported: Array.isArray(data?.imported) ? data.imported : [],
    skipped: Array.isArray(data?.skipped) ? data.skipped : [],
  };
}

function getUploadConflictData(error: unknown): SkillUploadConflictResponse | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    (error as { code?: string }).code !== "SKILL_CONFLICT"
  ) {
    return null;
  }
  const data = (error as { data?: SkillUploadConflictResponse }).data;
  if (!data || !Array.isArray(data.conflicts) || !Array.isArray(data.allowedStrategies)) return null;
  return data;
}

export function AgentSkillsPage() {
  const { t } = useTranslation(NS.SKILLS);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<SkillCreateMode>("text");
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formContent, setFormContent] = useState("");
  const [uploadItems, setUploadItems] = useState<UploadSkillSummary[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<SkillUploadConflictResponse["conflicts"]>([]);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);
  const [downloadingSkillKey, setDownloadingSkillKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SkillCatalogScope>("all");
  const editingReadOnly = editingSkill ? !canWriteSkill(editingSkill) : false;

  const resetUploadState = useCallback(() => {
    setUploadItems([]);
    setUploadError(null);
    setConflicts([]);
    setOverwriteConfirmOpen(false);
  }, []);

  const catalog = useRequest(() => unwrap(skillConfigApi.list()), {
    onError: (error) => {
      console.error(t("toast.loadListFailed"), error);
      toast.error(t("toast.loadListFailedWith", { message: error.message }));
    },
  });
  const skills = catalog.data?.skills ?? [];
  const loadSkillDetail = useCallback((skill: SkillInfo) => unwrap(skillConfigApi.get(getSkillLookupKey(skill))), []);

  const createSkill = useRequest(
    (params: { name: string; description: string; content: string }) =>
      unwrap(skillConfigApi.create(params.name, { description: params.description, content: params.content })),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("toast.skillCreated"));
        setDialogOpen(false);
        catalog.refresh();
        dispatchConfigChange("skills");
      },
      onError: (error) => toast.error(t("toast.saveFailedWith", { message: error.message })),
    },
  );

  const updateSkill = useRequest(
    (params: { name: string; description: string; content: string }) =>
      unwrap(skillConfigApi.update(params.name, { description: params.description, content: params.content })),
    {
      manual: true,
      onSuccess: () => {
        setDialogOpen(false);
        catalog.refresh();
        dispatchConfigChange("skills");
      },
      onError: (error) => toast.error(t("toast.saveFailedWith", { message: error.message })),
    },
  );

  const uploadSkills = useRequest((formData: FormData) => skillConfigApi.upload(formData), {
    manual: true,
    onSuccess: (response) => {
      if (response.success) {
        const result = normalizeSkillUploadResult(response.data);
        toast.success(
          result.skipped.length > 0
            ? t("toast.importResultWithSkipped", { imported: result.imported.length, skipped: result.skipped.length })
            : t("toast.importResult", { imported: result.imported.length }),
        );
        setDialogOpen(false);
        resetUploadState();
        catalog.refresh();
        dispatchConfigChange("skills");
        return;
      }
      const conflictData = getUploadConflictData(response.error);
      if (conflictData) {
        setConflicts(conflictData.conflicts);
        toast.error(t("conflict.detected"));
      } else {
        toast.error(t("toast.importFailedWith", { message: response.error?.message ?? "" }));
      }
    },
  });

  const deleteSkill = useRequest((name: string) => unwrap(skillConfigApi.del(name)), {
    manual: true,
    onSuccess: () => {
      setDeleteTarget(null);
      catalog.refresh();
      dispatchConfigChange("skills");
    },
    onError: (error) => {
      console.error(t("toast.deleteFailed"), error);
      toast.error(t("toast.deleteFailedWith", { message: error.message }));
    },
  });

  const { metaAgentId, chatOpen, setChatOpen } = useMetaAgent({ storageKey: "skills:chat-open" });

  const openCreate = (mode: SkillCreateMode) => {
    setEditingSkill(null);
    setCreateMode(mode);
    setFormName("");
    setFormDescription("");
    setFormContent("");
    resetUploadState();
    setDialogOpen(true);
  };

  const openSkill = async (skill: SkillInfo) => {
    setEditingSkill(skill);
    setCreateMode("text");
    resetUploadState();
    try {
      const detail = await unwrap(skillConfigApi.get(getSkillLookupKey(skill)));
      setFormName(detail.name ?? "");
      setFormDescription(detail.description ?? "");
      setFormContent(detail.content ?? "");
      setDialogOpen(true);
    } catch (error) {
      console.error(t("toast.loadDetailFailed"), error);
      toast.error(t("toast.loadDetailFailed"));
    }
  };

  const toggleSharing = async (skill: SkillInfo) => {
    if (!canManageSkillSharing(skill)) return;
    const nextPublicReadable = !skill.resourceAccess?.publicReadable;
    try {
      await unwrap(skillConfigApi.updateAccess(skill.name, nextPublicReadable));
      toast.success(nextPublicReadable ? tComponents("resource.makePublic") : tComponents("resource.makePrivate"));
      catalog.refresh();
      dispatchConfigChange("skills");
    } catch (error) {
      console.error(t("toast.saveFailed"), error);
      toast.error(t("toast.saveFailedWith", { message: (error as Error).message }));
    }
  };

  const selectUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const items = parseSkillUploadFiles(Array.from(event.target.files ?? []));
    setUploadItems(items);
    setUploadError(validateUploadBatch(items));
    setConflicts([]);
  };

  const upload = (strategy?: SkillUploadConflictStrategy) => {
    const validationError = validateUploadBatch(uploadItems);
    if (validationError) {
      setUploadError(validationError);
      toast.error(validationError);
      return;
    }
    uploadSkills.run(buildSkillUploadFormData(uploadItems, strategy));
  };

  const submitDialog = () => {
    if (!editingSkill && createMode === "upload") {
      upload();
      return;
    }
    const validationError = getSkillFormValidationError(formName, formContent);
    if (validationError) {
      toast.error(t(validationError));
      return;
    }
    const payload = { name: editingSkill?.name ?? formName, description: formDescription, content: formContent };
    if (editingSkill) updateSkill.run(payload);
    else createSkill.run(payload);
  };

  const download = useCallback(
    async (skill: SkillInfo) => {
      const skillKey = getSkillKey(skill);
      setDownloadingSkillKey(skillKey);
      try {
        const response = await skillConfigApi.download(getSkillLookupKey(skill));
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        const blobUrl = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = `${skill.name}.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        console.error(t("toast.downloadFailed"), error);
        toast.error(t("toast.downloadFailed"));
      } finally {
        setDownloadingSkillKey(null);
      }
    },
    [t],
  );

  return (
    <div className="flex min-h-0 flex-1">
      <AgentSkillsCatalog
        skills={skills}
        loading={catalog.loading}
        error={catalog.error}
        query={query}
        scope={scope}
        downloadingKey={downloadingSkillKey}
        onQueryChange={setQuery}
        onScopeChange={setScope}
        onCreate={openCreate}
        onConversationCreate={() => setChatOpen(true)}
        onDownload={(skill) => void download(skill)}
        onOpen={(skill) => void openSkill(skill)}
        onDelete={(skill) => setDeleteTarget(skill.name)}
        onToggleSharing={(skill) => void toggleSharing(skill)}
        onRetry={catalog.refresh}
        onLoadDetail={loadSkillDetail}
      />
      <AgentSkillsDialogs
        dialogOpen={dialogOpen}
        editingSkill={editingSkill}
        editingReadOnly={editingReadOnly}
        createMode={createMode}
        formName={formName}
        formDescription={formDescription}
        formContent={formContent}
        uploadItems={uploadItems}
        uploadError={uploadError}
        conflicts={conflicts}
        saving={createSkill.loading || updateSkill.loading}
        uploading={uploadSkills.loading}
        deleteOpen={deleteTarget !== null}
        deleteTarget={deleteTarget}
        overwriteOpen={overwriteConfirmOpen}
        onDialogOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) resetUploadState();
        }}
        onFormNameChange={setFormName}
        onFormDescriptionChange={setFormDescription}
        onFormContentChange={setFormContent}
        onUploadSelection={selectUpload}
        onReselect={resetUploadState}
        onSubmit={submitDialog}
        onResolveConflicts={upload}
        onRequestOverwrite={() => setOverwriteConfirmOpen(true)}
        onDeleteOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleteConfirm={() => {
          if (deleteTarget) deleteSkill.run(deleteTarget);
        }}
        onOverwriteOpenChange={setOverwriteConfirmOpen}
        onOverwriteConfirm={() => upload("overwrite")}
      />
      <MetaAgentPanel
        chatOpen={chatOpen}
        setChatOpen={setChatOpen}
        metaAgentId={metaAgentId}
        scenePrompt={undefined}
        onPromptComplete={catalog.refreshAsync}
        togglePosition="left"
      />
    </div>
  );
}
