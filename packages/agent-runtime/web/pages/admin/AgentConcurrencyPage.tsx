import { AdminKeyGate } from "@fenix/ui-components/config/AdminKeyGate";
import { Button } from "@fenix/ui-components/ui/button";
import { Card } from "@fenix/ui-components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { ApiError } from "@fenix/web-runtime/api/request";
import { useAdminKeyGate } from "@fenix/web-runtime/hooks/use-admin-key-gate";
import { useRequest } from "ahooks";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { agentConcurrencyApi, type UserConcurrencyPolicy } from "../../api/agent-concurrency";
import { AGENT_CONCURRENCY_NS } from "../../i18n/namespace";
import { ConcurrencyUserDialog } from "./concurrency-user-dialog";

const dimensions = ["agentMaxConcurrency", "userAgentMaxConcurrency", "scheduledAgentMaxConcurrency"] as const;
type Dimension = (typeof dimensions)[number];
type ResetTarget = { key: Dimension } | { user: UserConcurrencyPolicy };

/** 系统密钥保护的并发管理入口。 */
export function AgentConcurrencyPage() {
  const { t } = useTranslation(AGENT_CONCURRENCY_NS);
  const gate = useAdminKeyGate(t("loginError"));
  return (
    <AdminKeyGate
      unlocked={gate.unlocked}
      error={gate.error}
      onUnlock={gate.unlock}
      title={t("loginTitle")}
      description={t("loginDescription")}
      inputPlaceholder={t("loginPlaceholder")}
      submitLabel={t("loginSubmit")}
    >
      <ConcurrencyDashboard onAuthFailure={gate.fail} />
    </AdminKeyGate>
  );
}

function ConcurrencyDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { t } = useTranslation(AGENT_CONCURRENCY_NS);
  const [editing, setEditing] = useState<Dimension>();
  const [draft, setDraft] = useState("");
  const [userDialog, setUserDialog] = useState<{ user?: UserConcurrencyPolicy }>();
  const [reset, setReset] = useState<ResetTarget>();
  const [feedback, setFeedback] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busy, setBusy] = useState(false);
  const handleError = (error: Error) => {
    if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
  };
  const query = useRequest(
    async () => {
      const [policy, users] = await Promise.all([agentConcurrencyApi.getGlobal(), agentConcurrencyApi.listUsers()]);
      return { policy, users };
    },
    { onError: handleError },
  );
  const disabled = busy || query.loading;
  const valueLabel = (value: number | null) => (value === null ? t("unlimited") : t("limitValue", { count: value }));
  const run = async (operation: () => Promise<void>) => {
    if (disabled) return;
    setBusy(true);
    setFeedback("");
    setMutationError("");
    try {
      await operation();
      setFeedback(t("saved"));
      try {
        await query.refreshAsync();
      } catch (error) {
        // 写响应已提交；刷新失败仍保留提交结果与用户尚未提交的草稿。
        if (!(error instanceof Error)) throw error;
        handleError(error);
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      handleError(error);
      setMutationError(error.message === "invalidLimit" ? t("invalidLimit") : error.message);
    } finally {
      setBusy(false);
    }
  };
  const patch = async (key: Dimension, value: number | null) => {
    const policy = await agentConcurrencyApi.patchGlobal({ [key]: value });
    query.mutate((current) => ({ policy, users: current?.users ?? [] }));
    setEditing(undefined);
    setReset(undefined);
  };
  const policy = query.data?.policy;
  const resetSetting =
    reset && policy
      ? "key" in reset
        ? policy[reset.key]
        : { ...reset.user.policy.userAgentMaxConcurrency, defaultValue: policy.userAgentMaxConcurrency.value }
      : undefined;
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8" aria-busy={disabled}>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Button variant="outline" disabled={disabled} onClick={() => query.refresh()}>
          <RefreshCw className={query.loading ? "size-4 animate-spin" : "size-4"} aria-hidden="true" />
          {t("refresh")}
        </Button>
      </header>
      {query.loading && !policy && <p role="status">{t("loading")}</p>}
      {query.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <span>{query.data ? t("refreshFailed", { message: query.error.message }) : query.error.message}</span>
          <Button variant="outline" disabled={disabled} onClick={() => query.refresh()}>
            {t("retry")}
          </Button>
        </div>
      )}
      {mutationError && !reset && !userDialog && (
        <p role="alert" className="text-sm text-destructive">
          {mutationError}
        </p>
      )}
      {feedback && (
        <p role="status" className="text-sm text-primary">
          {feedback}
        </p>
      )}
      {policy && (
        <>
          <Card className="gap-0 overflow-hidden py-0 shadow-none">
            <div className="p-6">
              <h2 className="font-semibold">{t("global")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("globalHelp")}</p>
            </div>
            <div className="hidden grid-cols-3 border-y bg-muted/30 px-6 py-3 text-xs text-muted-foreground sm:grid">
              <span>{t("limitItem")}</span>
              <span>{t("effective")}</span>
              <span className="text-right">{t("actions")}</span>
            </div>
            {dimensions.map((key) => (
              <div key={key} className="grid gap-4 border-b px-6 py-6 last:border-b-0 sm:grid-cols-3 sm:items-center">
                <div>
                  <h3 className="text-sm font-medium">{t(key)}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{t(`hints.${key}`)}</p>
                </div>
                <div id={`effective-${key}`} className="flex flex-wrap items-center gap-3">
                  <span className="text-2xl font-semibold tabular-nums">{valueLabel(policy[key].value)}</span>
                  <span
                    className={
                      policy[key].source === "environment"
                        ? "rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
                        : "rounded bg-primary/10 px-2 py-1 text-xs text-primary"
                    }
                  >
                    {t(policy[key].source === "environment" ? "default" : "custom")}
                  </span>
                </div>
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled || editing === key}
                    aria-label={t("editLimit", { name: t(key) })}
                    onClick={() => {
                      setEditing(key);
                      setDraft(policy[key].value?.toString() ?? "");
                    }}
                  >
                    {t("edit")}
                  </Button>
                  {policy[key].override !== null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      disabled={disabled}
                      onClick={() => {
                        setMutationError("");
                        setReset({ key });
                      }}
                    >
                      {t("reset")}
                    </Button>
                  )}
                </div>
                {editing === key && (
                  <form
                    className="flex flex-wrap items-end gap-3 border-t border-dashed pt-4 sm:col-span-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(async () => {
                        const value = Number(draft);
                        if (!draft.trim() || !Number.isInteger(value) || value < 1 || value > 2147483647)
                          throw new Error("invalidLimit");
                        await patch(key, value);
                      });
                    }}
                  >
                    <label htmlFor="concurrency-limit" className="min-w-40 flex-1 text-sm">
                      {t("newLimit")}
                      <Input
                        id="concurrency-limit"
                        className="mt-2"
                        type="number"
                        min={1}
                        max={2147483647}
                        step={1}
                        required
                        value={draft}
                        disabled={disabled}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                    </label>
                    <p className="flex-1 text-xs text-muted-foreground">
                      {t("defaultHint", { value: valueLabel(policy[key].defaultValue) })}
                    </p>
                    <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(undefined)}>
                      {t("cancel")}
                    </Button>
                    <Button type="submit" disabled={disabled}>
                      {t("save")}
                    </Button>
                  </form>
                )}
              </div>
            ))}
          </Card>
          <Card className="gap-0 overflow-hidden py-0 shadow-none">
            <div className="flex flex-wrap items-center justify-between gap-4 p-6">
              <div>
                <h2 className="font-semibold">
                  {t("users")}
                  <span className="ml-2 rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                    {query.data?.users.length}
                  </span>
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{t("usersHelp")}</p>
              </div>
              <Button
                disabled={disabled}
                onClick={() => {
                  setMutationError("");
                  setUserDialog({});
                }}
              >
                <Plus className="size-4" aria-hidden="true" />
                {t("addUser")}
              </Button>
            </div>
            <div className="hidden grid-cols-3 border-y bg-muted/30 px-6 py-3 text-xs text-muted-foreground sm:grid">
              <span>{t("user")}</span>
              <span>{t("userLimit")}</span>
              <span className="text-right">{t("actions")}</span>
            </div>
            {!query.data?.users.length ? (
              <p className="p-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
            ) : (
              query.data.users.map((user) => (
                <div
                  key={user.userId}
                  className="grid gap-4 border-b px-6 py-5 last:border-b-0 sm:grid-cols-3 sm:items-center"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm text-primary"
                    >
                      {user.name.slice(0, 1)}
                    </span>
                    <span className="break-words text-sm font-medium">{user.name}</span>
                  </div>
                  <span className="text-lg font-semibold tabular-nums">
                    {valueLabel(user.policy.userAgentMaxConcurrency.value)}
                  </span>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={t("editUser", { name: user.name })}
                      onClick={() => {
                        setMutationError("");
                        setUserDialog({ user });
                      }}
                    >
                      {t("edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      disabled={disabled}
                      aria-label={t("resetUserLabel", { name: user.name })}
                      onClick={() => {
                        setMutationError("");
                        setReset({ user });
                      }}
                    >
                      {t("resetUser")}
                    </Button>
                  </div>
                </div>
              ))
            )}
            <p className="border-t bg-muted/20 px-6 py-4 text-xs text-muted-foreground">
              {t("userDefault", { value: valueLabel(policy.userAgentMaxConcurrency.value) })}
            </p>
          </Card>
          {userDialog && (
            <ConcurrencyUserDialog
              initialUser={userDialog.user}
              users={query.data?.users ?? []}
              defaultValue={policy.userAgentMaxConcurrency.value}
              busy={busy}
              error={mutationError}
              onClose={() => setUserDialog(undefined)}
              onAuthFailure={handleError}
              onSave={(id, value) =>
                run(async () => {
                  const committed = await agentConcurrencyApi.putUser(id, value);
                  query.mutate((current) =>
                    current
                      ? { ...current, users: [...current.users.filter((user) => user.userId !== id), committed] }
                      : current,
                  );
                  setUserDialog(undefined);
                })
              }
            />
          )}
          <Dialog
            open={!!reset}
            onOpenChange={(open) => {
              if (!open && !busy) setReset(undefined);
            }}
          >
            <DialogContent showCloseButton={!busy}>
              <DialogHeader>
                <DialogTitle>{t(reset && "user" in reset ? "resetUserTitle" : "resetTitle")}</DialogTitle>
                <DialogDescription>
                  {reset && "user" in reset ? t("resetUserHelp", { name: reset.user.name }) : t("resetHelp")}
                </DialogDescription>
              </DialogHeader>
              {resetSetting && (
                <div className="flex flex-wrap items-center gap-4 rounded-lg bg-muted/40 p-5 text-xl font-semibold tabular-nums">
                  <span>{valueLabel(resetSetting.value)}</span>
                  <span aria-hidden="true" className="text-muted-foreground">
                    →
                  </span>
                  <span>{valueLabel(resetSetting.defaultValue)}</span>
                </div>
              )}
              {mutationError && (
                <p role="alert" className="text-sm text-destructive">
                  {mutationError}
                </p>
              )}
              <DialogFooter>
                <Button variant="outline" disabled={busy} onClick={() => setReset(undefined)}>
                  {t("cancel")}
                </Button>
                <Button
                  disabled={disabled}
                  onClick={() =>
                    void run(async () => {
                      if (!reset) return;
                      if ("key" in reset) await patch(reset.key, null);
                      else {
                        const id = reset.user.userId;
                        await agentConcurrencyApi.deleteUser(id);
                        query.mutate((current) =>
                          current ? { ...current, users: current.users.filter((user) => user.userId !== id) } : current,
                        );
                        setReset(undefined);
                      }
                    })
                  }
                >
                  {t("confirmReset")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </main>
  );
}
