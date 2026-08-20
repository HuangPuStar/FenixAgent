import { useRequest } from "ahooks";
import { Bot, Building2, ChevronRight, KeyRound, RefreshCw, UserPlus, UserRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "../../api/request";
import {
  createSystemUser,
  fetchSystemPeopleTree,
  resetSystemUserPassword,
  type SystemPeopleOrganization,
} from "../../api/system-people-tree";
import { clearAdminKey, getAdminKey } from "../../lib/admin-key";
import { MasterKeyGate } from "./components/MasterKeyGate";

export function AdminPeoplePage() {
  const { t } = useTranslation("observer");
  const [unlocked, setUnlocked] = useState(() => getAdminKey() !== null);
  const [gateError, setGateError] = useState<string | null>(null);

  if (!unlocked) {
    return (
      <MasterKeyGate
        error={gateError}
        onUnlock={() => {
          setGateError(null);
          setUnlocked(true);
        }}
      />
    );
  }

  return (
    <PeopleDashboard
      onAuthFailure={() => {
        clearAdminKey();
        setGateError(t("login.error"));
        setUnlocked(false);
      }}
    />
  );
}

function PeopleDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { t } = useTranslation("observer");
  const [dialog, setDialog] = useState<"create" | "reset" | null>(null);
  const { data, loading, error, refresh } = useRequest(fetchSystemPeopleTree, {
    onError: (err) => {
      if (err instanceof ApiError && err.code === "UNAUTHORIZED") onAuthFailure();
    },
  });
  const createRequest = useRequest(createSystemUser, {
    manual: true,
    onSuccess: () => {
      toast.success(t("people.createSuccess"));
      setDialog(null);
      refresh();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "UNAUTHORIZED") onAuthFailure();
      else toast.error(t("people.actionError"), { description: err instanceof Error ? err.message : undefined });
    },
  });
  const resetRequest = useRequest(resetSystemUserPassword, {
    manual: true,
    onSuccess: () => {
      toast.success(t("people.resetSuccess"));
      setDialog(null);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "UNAUTHORIZED") onAuthFailure();
      else toast.error(t("people.actionError"), { description: err instanceof Error ? err.message : undefined });
    },
  });
  const organizations = data?.organizations ?? [];

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{t("people.title")}</h1>
            <p className="text-xs text-text-muted">{t("people.subtitle")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setDialog("reset")}>
              <KeyRound className="size-3.5" />
              {t("people.resetPassword")}
            </Button>
            <Button size="sm" onClick={() => setDialog("create")}>
              <UserPlus className="size-3.5" />
              {t("people.createUser")}
            </Button>
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              <RefreshCw className="size-3.5" />
              {t("states.refresh")}
            </Button>
          </div>
        </header>

        {loading && !data ? <Skeleton className="h-64 w-full" /> : null}
        {error && !data ? (
          <Card>
            <CardContent className="space-y-3 py-8 text-center">
              <p className="text-sm text-destructive">{t("people.error")}</p>
              <Button variant="outline" onClick={refresh}>
                {t("states.retry")}
              </Button>
            </CardContent>
          </Card>
        ) : null}
        {!loading && !error && organizations.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-text-muted">{t("people.empty")}</CardContent>
          </Card>
        ) : null}
        {organizations.length > 0 ? <PeopleTree organizations={organizations} /> : null}
      </div>
      <UserActionDialog
        action={dialog}
        loading={createRequest.loading || resetRequest.loading}
        onOpenChange={(open) => !open && setDialog(null)}
        onCreate={(input) => void createRequest.runAsync(input)}
        onReset={(input) => void resetRequest.runAsync(input)}
      />
    </div>
  );
}

function UserActionDialog({
  action,
  loading,
  onOpenChange,
  onCreate,
  onReset,
}: {
  action: "create" | "reset" | null;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; email: string; password: string }) => void;
  onReset: (input: { email: string; password: string }) => void;
}) {
  const { t } = useTranslation("observer");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const isCreate = action === "create";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail || password.length < 8 || (isCreate && !name.trim())) return;
    if (isCreate) onCreate({ name: name.trim(), email: normalizedEmail, password });
    else onReset({ email: normalizedEmail, password });
  };
  const close = (open: boolean) => {
    if (!open && !loading) {
      setName("");
      setEmail("");
      setPassword("");
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={action !== null} onOpenChange={close}>
      <DialogContent disableOverlayClose={loading} disableEscapeClose={loading}>
        <DialogHeader>
          <DialogTitle>{isCreate ? t("people.createUser") : t("people.resetPassword")}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          {isCreate ? (
            <div className="space-y-2">
              <Label htmlFor="people-user-name">{t("people.name")}</Label>
              <Input id="people-user-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="people-user-email">{t("people.email")}</Label>
            <Input
              id="people-user-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoFocus={!isCreate}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="people-user-password">{t("people.password")}</Label>
            <Input
              id="people-user-password"
              type="password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs text-text-muted">{t("people.passwordHint")}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)} disabled={loading}>
              {t("people.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={loading || !email.trim() || password.length < 8 || (isCreate && !name.trim())}
            >
              {loading ? t("people.submitting") : isCreate ? t("people.createUser") : t("people.resetPassword")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PeopleTree({ organizations }: { organizations: SystemPeopleOrganization[] }) {
  const { t } = useTranslation("observer");
  return (
    <div className="space-y-3">
      {organizations.map((organization) => (
        <details key={organization.id} open className="group rounded-lg border border-border bg-card">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:content-none">
            <ChevronRight className="size-4 text-text-muted transition-transform group-open:rotate-90" />
            <Building2 className="size-4 text-brand" />
            <span className="font-medium text-text-primary">{organization.name}</span>
            <span className="font-mono text-xs text-text-muted">{organization.slug}</span>
            <Badge variant="secondary" className="ml-auto">
              {t("people.users", { count: organization.users.length })}
            </Badge>
          </summary>
          <div className="border-t border-border px-4 py-3">
            {organization.users.length === 0 ? (
              <p className="text-sm text-text-muted">{t("people.noUsers")}</p>
            ) : (
              <ul className="space-y-2 border-l border-brand/30 pl-3">
                {organization.users.map((person) => (
                  <li key={person.id}>
                    <details open className="group/user">
                      <summary className="flex cursor-pointer list-none items-center gap-2 py-1 marker:content-none">
                        <ChevronRight className="size-3.5 text-text-muted transition-transform group-open/user:rotate-90" />
                        <UserRound className="size-3.5 text-accent-tiffany" />
                        <span className="text-sm font-medium text-text-primary">{person.name}</span>
                        <span className="text-xs text-text-muted">{person.email}</span>
                        {person.role ? (
                          <Badge variant="outline" className="text-[10px]">
                            {person.role}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            {t("people.unassignedRole")}
                          </Badge>
                        )}
                        <Badge variant="secondary" className="ml-auto text-[10px]">
                          {t("people.agents", { count: person.agents.length })}
                        </Badge>
                      </summary>
                      <ul className="ml-5 space-y-1 border-l border-accent-green/30 pl-3">
                        {person.agents.length === 0 ? (
                          <li className="py-1 text-xs text-text-muted">{t("people.noAgents")}</li>
                        ) : (
                          person.agents.map((agent) => (
                            <li key={agent.id} className="flex flex-wrap items-center gap-2 rounded-md py-1 text-sm">
                              <Bot className="size-3.5 text-accent-green" />
                              <span className="text-text-primary">{agent.name}</span>
                              {agent.engineType ? (
                                <Badge variant="outline" className="text-[10px]">
                                  {agent.engineType}
                                </Badge>
                              ) : null}
                              {agent.machineId ? (
                                <span className="font-mono text-[10px] text-text-muted">{agent.machineId}</span>
                              ) : null}
                              {agent.description ? (
                                <span className="w-full pl-5 text-xs text-text-muted">{agent.description}</span>
                              ) : null}
                            </li>
                          ))
                        )}
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
