import { useRequest } from "ahooks";
import { Bot, Building2, ChevronRight, RefreshCw, UserRound } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "../../api/request";
import { fetchSystemPeopleTree, type SystemPeopleOrganization } from "../../api/system-people-tree";
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
  const { data, loading, error, refresh } = useRequest(fetchSystemPeopleTree, {
    onError: (err) => {
      if (err instanceof ApiError && err.code === "UNAUTHORIZED") onAuthFailure();
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
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className="size-3.5" />
            {t("states.refresh")}
          </Button>
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
    </div>
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
