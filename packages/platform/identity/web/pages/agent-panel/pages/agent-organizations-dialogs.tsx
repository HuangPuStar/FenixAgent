import { LabeledField } from "@fenix/ui-components/config/LabeledField";
import { copyTextToClipboard } from "@fenix/ui-components/lib/clipboard";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Check, Copy, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { OrgMemberCandidate } from "../../../api/organizations";
import { ORG_SELECT_CLASS } from "./agent-organizations-classes";
import type { MachineFormState, OrganizationsDialogsProps } from "./agent-organizations-types";

function CreateOrganizationDialog({ props }: { props: OrganizationsDialogsProps }) {
  const { t } = useTranslation(NS.ORGS);
  return (
    <Dialog open={props.createOpen} onOpenChange={props.onCreateOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createDialog.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3.5 py-2">
          <LabeledField label={t("createDialog.name")}>
            <Input
              value={props.formName}
              onChange={(event) => props.onFormNameChange(event.target.value)}
              placeholder={t("createDialog.namePlaceholder")}
            />
          </LabeledField>
          <LabeledField label={t("createDialog.slug")}>
            <Input
              value={props.formSlug}
              onChange={(event) => props.onFormSlugChange(event.target.value)}
              placeholder="url-identifier"
            />
          </LabeledField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onCreateOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={props.onCreate} disabled={props.createLoading || !props.formName.trim()}>
            {props.createLoading ? t("creating") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MemberCandidateButton({
  candidate,
  selected,
  onAdd,
}: {
  candidate: OrgMemberCandidate;
  selected: boolean;
  onAdd: (candidate: OrgMemberCandidate) => void;
}) {
  const { t } = useTranslation(NS.ORGS);
  const disabled = candidate.isMember || selected;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-none border-0 bg-transparent px-3 py-2 text-left enabled:hover:bg-surface-2 focus-visible:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={() => onAdd(candidate)}
    >
      <div className="min-w-0 flex-1">
        <strong className="block truncate">{candidate.name}</strong>
        <span className="block truncate text-sm text-text-muted">{candidate.email}</span>
      </div>
      {candidate.isMember ? <Badge variant="outline">{t("inviteDialog.alreadyMember")}</Badge> : null}
      {selected ? <Check className="size-4 text-brand" /> : null}
    </button>
  );
}

function InviteMemberDialog({ props }: { props: OrganizationsDialogsProps }) {
  const { t } = useTranslation(NS.ORGS);
  const showResults = props.debouncedInviteKeyword.length >= 3;
  return (
    <Dialog open={props.inviteOpen} onOpenChange={props.onInviteOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("inviteDialog.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3.5 py-2">
          {/* 字段名走**显式关联**：字段名标注的是搜索框，而接口区里还有已选成员的移除按钮与结果列表
              （都是可标记元素），包进 `<label>` 会把它们的文案并进搜索框的可访问名。
              字段名刻度随之与同文件其余字段统一（原 `.org-dialog-field > span` 的 12px/600/#516079）。 */}
          <LabeledField label={t("inviteDialog.searchLabel")} htmlFor="org-member-search">
            <div className="overflow-hidden rounded-md border border-slate-200">
              {props.selectedCandidates.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 border-b border-slate-100 p-2">
                  {props.selectedCandidates.map((candidate) => (
                    <span
                      key={candidate.id}
                      className="flex items-center gap-1.5 rounded-md bg-blue-50 px-1.75 py-1 text-sm text-blue-900"
                    >
                      <strong>{candidate.name}</strong>
                      <button
                        type="button"
                        className="border-0 bg-transparent p-0"
                        onClick={() => props.onCandidateRemove(candidate.id)}
                        aria-label={t("inviteDialog.removeSelected")}
                      >
                        <X className="size-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center pl-3 text-text-muted">
                <Search className="size-4" aria-hidden="true" />
                <Input
                  id="org-member-search"
                  value={props.inviteKeyword}
                  onChange={(event) => props.onInviteKeywordChange(event.target.value)}
                  placeholder={
                    props.selectedCandidates.length > 0
                      ? t("inviteDialog.searchMorePlaceholder")
                      : t("inviteDialog.searchPlaceholder")
                  }
                  className="rounded-none border-0 shadow-none"
                />
              </div>
              <div className="max-h-56 overflow-y-auto border-t border-slate-100">
                {props.debouncedInviteKeyword.length === 0 ? (
                  <div className="p-4 text-sm text-text-muted">{t("inviteDialog.searchHint")}</div>
                ) : null}
                {props.debouncedInviteKeyword.length > 0 && props.debouncedInviteKeyword.length < 3 ? (
                  <div className="p-4 text-sm text-text-muted">{t("inviteDialog.searchMinChars")}</div>
                ) : null}
                {showResults && props.memberCandidatesLoading ? (
                  <div className="p-4 text-sm text-text-muted">{t("inviteDialog.searching")}</div>
                ) : null}
                {showResults && !props.memberCandidatesLoading && props.memberCandidates.length === 0 ? (
                  <div className="p-4 text-sm text-text-muted">{t("inviteDialog.empty")}</div>
                ) : null}
                {props.memberCandidates.map((candidate) => {
                  const selected = props.selectedCandidates.some((item) => item.id === candidate.id);
                  return (
                    <MemberCandidateButton
                      key={candidate.id}
                      candidate={candidate}
                      selected={selected}
                      onAdd={props.onCandidateAdd}
                    />
                  );
                })}
              </div>
            </div>
          </LabeledField>
          <LabeledField label={t("inviteDialog.role")}>
            <select
              className={ORG_SELECT_CLASS}
              value={props.inviteRole}
              onChange={(event) => props.onInviteRoleChange(event.target.value)}
            >
              <option value="admin">{t("roles.admin")}</option>
              <option value="member">{t("roles.member")}</option>
            </select>
          </LabeledField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onInviteOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={props.onInvite} disabled={props.inviteLoading || props.selectedCandidates.length === 0}>
            {props.inviteLoading ? t("inviteDialog.inviting") : t("inviteDialog.invite")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialogs({ props }: { props: OrganizationsDialogsProps }) {
  const { t } = useTranslation(NS.ORGS);
  return (
    <>
      <AlertDialog open={props.deleteOpen} onOpenChange={props.onDeleteOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDialog.description", { name: props.organizationName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            {/* destructive 变体即 Button 的破坏性配色，不再逐处手抄一份色值类串。 */}
            <AlertDialogAction variant="destructive" onClick={props.onDelete} disabled={props.deleteLoading}>
              {props.deleteLoading ? t("deleteDialog.deleting") : t("deleteDialog.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!props.removeMemberTarget}
        onOpenChange={(open) => !open && props.onRemoveMemberTargetChange(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeMemberDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeMemberDialog.description", {
                name: props.removeMemberTarget?.user?.name || props.removeMemberTarget?.userId,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={props.onConfirmRemoveMember}
              disabled={props.removeMemberLoading}
            >
              {props.removeMemberLoading ? t("removeMemberDialog.removing") : t("removeMemberDialog.confirmRemove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!props.machineDeleteTarget}
        onOpenChange={(open) => !open && props.onMachineDeleteTargetChange(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteMachineDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteMachineDialog.description", {
                name: props.machineDeleteTarget?.name || props.machineDeleteTarget?.id,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={props.onDeleteMachine}
              disabled={props.deleteMachineLoading}
            >
              {props.deleteMachineLoading ? t("deleteMachineDialog.deleting") : t("deleteMachineDialog.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function MachineFields({
  form,
  onChange,
  prefix,
}: {
  form: MachineFormState;
  onChange: (form: MachineFormState) => void;
  prefix: "createMachineDialog" | "editMachineDialog";
}) {
  const { t } = useTranslation(NS.ORGS);
  return (
    <div className="grid gap-3.5 py-2">
      <LabeledField label={t(`${prefix}.name`)}>
        <Input
          value={form.name}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
          placeholder={t(`${prefix}.namePlaceholder`)}
          maxLength={64}
        />
      </LabeledField>
      <LabeledField label={t(`${prefix}.labels`)}>
        <Input
          value={form.labels}
          onChange={(event) => onChange({ ...form, labels: event.target.value })}
          placeholder={t(`${prefix}.labelsPlaceholder`)}
        />
      </LabeledField>
      <LabeledField label={t(`${prefix}.agentName`)}>
        <select
          className={ORG_SELECT_CLASS}
          value={form.agentName}
          onChange={(event) => onChange({ ...form, agentName: event.target.value })}
        >
          <option value="peri">Peri</option>
          <option value="opencode">OpenCode</option>
          <option value="ccb">CCB</option>
          <option value="claude-code">Claude Code</option>
        </select>
      </LabeledField>
    </div>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation(NS.ORGS);
  return (
    <LabeledField label={label}>
      <div className="flex min-w-0 items-center gap-1.5 bg-surface-2 px-2.5 py-2">
        <code className="min-w-0 flex-1 truncate text-sm text-slate-600">{value}</code>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("copy")}
          onClick={() =>
            void copyTextToClipboard(value).then((ok) =>
              ok ? toast.success(t("copied")) : toast.error(t("copyFailed")),
            )
          }
        >
          <Copy className="size-4" />
        </Button>
      </div>
    </LabeledField>
  );
}

function MachineDialogs({ props }: { props: OrganizationsDialogsProps }) {
  const { t } = useTranslation(NS.ORGS);
  return (
    <>
      <Dialog open={props.machineCreateOpen} onOpenChange={props.onMachineCreateOpenChange}>
        <DialogContent>
          {props.machineCreateResult ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("createMachineDialog.resultTitle")}</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-text-secondary">{t("createMachineDialog.resultDesc")}</p>
              <div className="grid gap-3.5 py-2">
                <CopyValue label={t("machineId")} value={props.machineCreateResult.id} />
                <CopyValue label={t("createMachineDialog.initCommand")} value={props.machineCreateResult.initCommand} />
              </div>
              <DialogFooter>
                <Button onClick={() => props.onMachineCreateOpenChange(false)}>{t("done")}</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t("createMachineDialog.title")}</DialogTitle>
              </DialogHeader>
              <MachineFields
                form={props.machineForm}
                onChange={props.onMachineFormChange}
                prefix="createMachineDialog"
              />
              <DialogFooter>
                <Button variant="ghost" onClick={() => props.onMachineCreateOpenChange(false)}>
                  {t("cancel")}
                </Button>
                <Button
                  onClick={props.onCreateMachine}
                  disabled={props.createMachineLoading || !props.machineForm.name.trim()}
                >
                  {props.createMachineLoading ? t("creating") : t("create")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={props.machineEditOpen} onOpenChange={props.onMachineEditOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("editMachineDialog.title")}</DialogTitle>
          </DialogHeader>
          <MachineFields form={props.machineForm} onChange={props.onMachineFormChange} prefix="editMachineDialog" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => props.onMachineEditOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={props.onUpdateMachine}
              disabled={props.updateMachineLoading || !props.machineForm.name.trim()}
            >
              {props.updateMachineLoading ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function OrganizationsDialogs(props: OrganizationsDialogsProps) {
  return (
    <>
      <CreateOrganizationDialog props={props} />
      <InviteMemberDialog props={props} />
      <ConfirmDialogs props={props} />
      <MachineDialogs props={props} />
    </>
  );
}
