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
import type { MachineFormState, OrganizationsDialogsProps } from "./agent-organizations-types";

function CreateOrganizationDialog({ props }: { props: OrganizationsDialogsProps }) {
  const { t } = useTranslation(NS.ORGS);
  return (
    <Dialog open={props.createOpen} onOpenChange={props.onCreateOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createDialog.title")}</DialogTitle>
        </DialogHeader>
        <div className="org-dialog-fields">
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
    <button type="button" className="org-member-candidate" disabled={disabled} onClick={() => onAdd(candidate)}>
      <div className="org-candidate-copy">
        <strong>{candidate.name}</strong>
        <span>{candidate.email}</span>
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
        <div className="org-dialog-fields">
          <div className="org-dialog-field">
            <span>{t("inviteDialog.searchLabel")}</span>
            <div className="org-member-command">
              {props.selectedCandidates.length > 0 ? (
                <div className="org-selected-members">
                  {props.selectedCandidates.map((candidate) => (
                    <span key={candidate.id}>
                      <strong>{candidate.name}</strong>
                      <button
                        type="button"
                        onClick={() => props.onCandidateRemove(candidate.id)}
                        aria-label={t("inviteDialog.removeSelected")}
                      >
                        <X className="size-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="org-member-search">
                <Search className="size-4" aria-hidden="true" />
                <Input
                  value={props.inviteKeyword}
                  onChange={(event) => props.onInviteKeywordChange(event.target.value)}
                  placeholder={
                    props.selectedCandidates.length > 0
                      ? t("inviteDialog.searchMorePlaceholder")
                      : t("inviteDialog.searchPlaceholder")
                  }
                  className="org-member-search-input"
                />
              </div>
              <div className="org-member-results">
                {props.debouncedInviteKeyword.length === 0 ? (
                  <div className="org-command-hint">{t("inviteDialog.searchHint")}</div>
                ) : null}
                {props.debouncedInviteKeyword.length > 0 && props.debouncedInviteKeyword.length < 3 ? (
                  <div className="org-command-hint">{t("inviteDialog.searchMinChars")}</div>
                ) : null}
                {showResults && props.memberCandidatesLoading ? (
                  <div className="org-command-hint">{t("inviteDialog.searching")}</div>
                ) : null}
                {showResults && !props.memberCandidatesLoading && props.memberCandidates.length === 0 ? (
                  <div className="org-command-hint">{t("inviteDialog.empty")}</div>
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
          </div>
          <LabeledField label={t("inviteDialog.role")}>
            <select value={props.inviteRole} onChange={(event) => props.onInviteRoleChange(event.target.value)}>
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
    <div className="org-dialog-fields">
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
        <select value={form.agentName} onChange={(event) => onChange({ ...form, agentName: event.target.value })}>
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
      <div className="org-copy-value">
        <code>{value}</code>
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
              <p className="org-dialog-description">{t("createMachineDialog.resultDesc")}</p>
              <div className="org-dialog-fields">
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
