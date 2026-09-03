import { type ChangeEvent, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NS } from "../../../i18n";
import type {
  SkillUploadConflictResponse,
  SkillUploadConflictStrategy,
  UploadSkillSummary,
} from "../../../types/config";
import type { SkillCreateMode, SkillInfo } from "./agent-skills-types";

type AgentSkillsDialogsProps = {
  dialogOpen: boolean;
  editingSkill: SkillInfo | null;
  editingReadOnly: boolean;
  createMode: SkillCreateMode;
  formName: string;
  formDescription: string;
  formContent: string;
  uploadItems: UploadSkillSummary[];
  uploadError: string | null;
  conflicts: SkillUploadConflictResponse["conflicts"];
  saving: boolean;
  uploading: boolean;
  deleteOpen: boolean;
  deleteTarget: string | null;
  overwriteOpen: boolean;
  onDialogOpenChange: (open: boolean) => void;
  onFormNameChange: (value: string) => void;
  onFormDescriptionChange: (value: string) => void;
  onFormContentChange: (value: string) => void;
  onUploadSelection: (event: ChangeEvent<HTMLInputElement>) => void;
  onReselect: () => void;
  onSubmit: () => void;
  onResolveConflicts: (strategy: SkillUploadConflictStrategy) => void;
  onRequestOverwrite: () => void;
  onDeleteOpenChange: (open: boolean) => void;
  onDeleteConfirm: () => void;
  onOverwriteOpenChange: (open: boolean) => void;
  onOverwriteConfirm: () => void;
};

const directoryInputProps = { webkitdirectory: "", directory: "" } as Record<string, string>;

export function AgentSkillsDialogs(props: AgentSkillsDialogsProps) {
  const { t } = useTranslation(NS.SKILLS);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const overwriteNames = props.conflicts.map((conflict) => conflict.name).join(", ");
  const uploadMode = !props.editingSkill && props.createMode === "upload";
  return (
    <>
      <FormDialog
        open={props.dialogOpen}
        onOpenChange={props.onDialogOpenChange}
        title={
          props.editingSkill
            ? props.editingReadOnly
              ? t("dialog.detailTitle")
              : t("dialog.editTitle")
            : uploadMode
              ? t("dialog.uploadTitle")
              : t("dialog.createTitle")
        }
        onSubmit={props.onSubmit}
        submitLabel={uploadMode ? t("dialog.startUpload") : t("dialog.save")}
        loading={props.saving || props.uploading}
        disabled={props.editingReadOnly || (uploadMode && !props.uploadItems.some((item) => item.hasSkillMd))}
        hideSubmit={props.editingReadOnly}
        width="sm:max-w-4xl"
      >
        {uploadMode ? (
          <div className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={props.onUploadSelection}
              className="hidden"
              {...directoryInputProps}
            />
            {props.uploadItems.length === 0 ? (
              <button
                type="button"
                className="w-full rounded-xl border-2 border-dashed border-border-light bg-surface-2/30 p-8 text-center transition-colors hover:border-brand/40 hover:bg-brand-subtle/30"
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="block text-sm font-medium text-text-primary">{t("upload.selectFolder")}</span>
                <span className="mt-1 block text-xs text-text-muted">{t("upload.selectFolderHint")}</span>
              </button>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text-primary">
                    {t("upload.selectedDirs", { count: props.uploadItems.length })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      props.onReselect();
                      if (fileInputRef.current) fileInputRef.current.value = "";
                      fileInputRef.current?.click();
                    }}
                  >
                    {t("btn.reselect")}
                  </Button>
                </div>
                <div className="grid max-h-48 gap-2 overflow-y-auto">
                  {props.uploadItems.map((item) => (
                    <UploadItemCard key={item.skillName} item={item} />
                  ))}
                </div>
              </div>
            )}
            {props.uploadError ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                {props.uploadError}
              </div>
            ) : null}
            {props.conflicts.length > 0 ? (
              <div className="space-y-3 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-sm">
                <div className="font-medium text-warning-text">{t("conflict.title")}</div>
                <div className="space-y-1">
                  {props.conflicts.map((conflict) => (
                    <div key={conflict.name} className="font-mono text-xs text-text-primary">
                      {conflict.name}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={props.uploading}
                    onClick={() => props.onResolveConflicts("ignore")}
                  >
                    {t("conflict.skipConflicts")}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={props.uploading}
                    onClick={props.onRequestOverwrite}
                  >
                    {t("conflict.overwriteExisting")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <SkillTextFields
            readOnly={props.editingReadOnly}
            lockName={Boolean(props.editingSkill)}
            name={props.formName}
            description={props.formDescription}
            content={props.formContent}
            onNameChange={props.onFormNameChange}
            onDescriptionChange={props.onFormDescriptionChange}
            onContentChange={props.onFormContentChange}
          />
        )}
        {props.editingReadOnly ? (
          <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-text-muted">
            {tComponents("resource.readOnly")}
          </p>
        ) : null}
      </FormDialog>

      <ConfirmDialog
        open={props.deleteOpen}
        onOpenChange={props.onDeleteOpenChange}
        title={t("confirm.deleteTitle")}
        description={t("confirm.deleteDescription", { name: props.deleteTarget ?? "" })}
        variant="destructive"
        onConfirm={props.onDeleteConfirm}
      />
      <ConfirmDialog
        open={props.overwriteOpen}
        onOpenChange={props.onOverwriteOpenChange}
        title={t("confirm.overwriteTitle")}
        description={t("confirm.overwriteDescription", { names: overwriteNames })}
        variant="destructive"
        confirmLabel={t("confirm.overwriteConfirm")}
        onConfirm={props.onOverwriteConfirm}
        loading={props.uploading}
      />
    </>
  );
}

function SkillTextFields({
  readOnly,
  lockName,
  name,
  description,
  content,
  onNameChange,
  onDescriptionChange,
  onContentChange,
}: {
  readOnly: boolean;
  lockName: boolean;
  name: string;
  description: string;
  content: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onContentChange: (value: string) => void;
}) {
  const { t } = useTranslation(NS.SKILLS);
  return (
    <div className="space-y-4">
      <label className="block text-sm font-medium text-text-primary">
        {t("form.name")}
        <Input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          disabled={lockName || readOnly}
          placeholder="my-skill"
          className="mt-1 font-mono text-sm"
        />
      </label>
      <label className="block text-sm font-medium text-text-primary">
        {t("form.description")}
        <Textarea
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          disabled={readOnly}
          className="mt-1 min-h-[80px] text-sm"
          placeholder={t("form.descriptionPlaceholder")}
        />
      </label>
      <label className="block text-sm font-medium text-text-primary">
        {t("form.content")}
        <span className="mb-1.5 mt-1 block text-xs font-normal text-text-muted">{t("form.contentHint")}</span>
        <Textarea
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          disabled={readOnly}
          className="min-h-[300px] font-mono text-sm"
          placeholder={t("form.contentPlaceholder")}
        />
      </label>
    </div>
  );
}

function UploadItemCard({ item }: { item: UploadSkillSummary }) {
  const { t } = useTranslation(NS.SKILLS);
  return (
    <div
      className={`flex items-center gap-3 rounded-lg px-3 py-2 ${item.hasSkillMd ? "bg-surface-1" : "bg-amber-50 dark:bg-amber-900/20"}`}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-text-bright">{item.skillName}</span>
      <span className="text-xs text-text-muted">{t("upload.files", { count: item.fileCount })}</span>
      <span className={`text-xs font-medium ${item.hasSkillMd ? "text-status-active" : "text-amber-600"}`}>
        {item.hasSkillMd ? t("upload.importable") : t("upload.missingSkillMd")}
      </span>
    </div>
  );
}
