import { Check, Copy, X } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { MachineFormState, OrganizationsDialogsProps } from "./agent-organizations-types";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="org-dialog-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function CreateOrganizationDialog({ props }: { props: OrganizationsDialogsProps }) {
  const { t } = useTranslation("orgs");
  return (
    <Dialog open={props.createOpen} onOpenChange={props.onCreateOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createDialog.title")}</DialogTitle>
        </DialogHeader>
        <div className="org-dialog-fields">
          <Field label={t("createDialog.name")}>
            <Input
              value={props.formName}
              onChange={(event) => props.onFormNameChange(event.target.value)}
              placeholder={t("createDialog.namePlaceholder")}
            />
          </Field>
          <Field label={t("createDialog.slug")}>
            <Input
              value={props.formSlug}
              onChange={(event) => props.onFormSlugChange(event.target.value)}
              placeholder="url-identifier"
            />
          </Field>
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

function InviteMemberDialog({ props }: { props: OrganizationsDialogsProps }) {
  const { t } = useTranslation("orgs");
  const showResults = props.debouncedInviteKeyword.length >= 3;
  return (
    <Dialog open={props.inviteOpen} onOpenChange={props.onInviteOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("inviteDialog.title")}</DialogTitle>
        </DialogHeader>
        <div className="org-dialog-fields">
          <Field label={t("inviteDialog.searchLabel")}>
            <Command shouldFilter={false} className="org-member-command">
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
              <CommandInput
                value={props.inviteKeyword}
                onValueChange={props.onInviteKeywordChange}
                placeholder={
                  props.selectedCandidates.length > 0
                    ? t("inviteDialog.searchMorePlaceholder")
                    : t("inviteDialog.searchPlaceholder")
                }
              />
              <CommandList className="max-h-56">
                {props.debouncedInviteKeyword.length === 0 ? (
                  <div className="org-command-hint">{t("inviteDialog.searchHint")}</div>
                ) : null}
                {props.debouncedInviteKeyword.length > 0 && props.debouncedInviteKeyword.length < 3 ? (
                  <div className="org-command-hint">{t("inviteDialog.searchMinChars")}</div>
                ) : null}
                {showResults ? (
                  <CommandEmpty>
                    {props.memberCandidatesLoading ? t("inviteDialog.searching") : t("inviteDialog.empty")}
                  </CommandEmpty>
                ) : null}
                {props.memberCandidates.length > 0 ? (
                  <CommandGroup>
                    {props.memberCandidates.map((candidate) => {
                      const selected = props.selectedCandidates.some((item) => item.id === candidate.id);
                      const disabled = candidate.isMember || selected;
                      return (
                        <CommandItem
                          key={candidate.id}
                          value={candidate.id}
                          disabled={disabled}
                          onSelect={() => !disabled && props.onCandidateAdd(candidate)}
                        >
                          <div className="org-candidate-copy">
                            <strong>{candidate.name}</strong>
                            <span>{candidate.email}</span>
                          </div>
                          {candidate.isMember ? (
                            <Badge variant="outline">{t("inviteDialog.alreadyMember")}</Badge>
                          ) : null}
                          {selected ? <Check className="size-4 text-brand" /> : null}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ) : null}
              </CommandList>
            </Command>
          </Field>
          <Field label={t("inviteDialog.role")}>
            <select value={props.inviteRole} onChange={(event) => props.onInviteRoleChange(event.target.value)}>
              <option value="admin">{t("roles.admin")}</option>
              <option value="member">{t("roles.member")}</option>
            </select>
          </Field>
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
  const { t } = useTranslation("orgs");
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
            <AlertDialogAction
              onClick={props.onDelete}
              disabled={props.deleteLoading}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
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
              onClick={props.onConfirmRemoveMember}
              disabled={props.removeMemberLoading}
              className="bg-destructive text-white hover:bg-destructive/90"
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
              onClick={props.onDeleteMachine}
              disabled={props.deleteMachineLoading}
              className="bg-destructive text-white hover:bg-destructive/90"
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
  const { t } = useTranslation("orgs");
  return (
    <div className="org-dialog-fields">
      <Field label={t(`${prefix}.name`)}>
        <Input
          value={form.name}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
          placeholder={t(`${prefix}.namePlaceholder`)}
          maxLength={64}
        />
      </Field>
      <Field label={t(`${prefix}.labels`)}>
        <Input
          value={form.labels}
          onChange={(event) => onChange({ ...form, labels: event.target.value })}
          placeholder={t(`${prefix}.labelsPlaceholder`)}
        />
      </Field>
      <Field label={t(`${prefix}.agentName`)}>
        <select value={form.agentName} onChange={(event) => onChange({ ...form, agentName: event.target.value })}>
          <option value="opencode">OpenCode</option>
          <option value="ccb">CCB</option>
          <option value="claude-code">Claude Code</option>
        </select>
      </Field>
    </div>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation("orgs");
  return (
    <Field label={label}>
      <div className="org-copy-value">
        <code>{value}</code>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => {
            navigator.clipboard.writeText(value);
            toast.success(t("copied"));
          }}
        >
          <Copy className="size-4" />
        </Button>
      </div>
    </Field>
  );
}

function MachineDialogs({ props }: { props: OrganizationsDialogsProps }) {
  const { t } = useTranslation("orgs");
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
