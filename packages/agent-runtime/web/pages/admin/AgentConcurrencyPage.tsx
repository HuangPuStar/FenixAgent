import { AdminKeyGate } from "@fenix/ui-components/config/AdminKeyGate";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@fenix/ui-components/ui/card";
import { Input } from "@fenix/ui-components/ui/input";
import { ApiError } from "@fenix/web-runtime/api/request";
import { useAdminKeyGate } from "@fenix/web-runtime/hooks/use-admin-key-gate";
import { useRequest } from "ahooks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  agentConcurrencyApi,
  type ConcurrencyPatch,
  type ConcurrencyPolicyView,
  type UserConcurrencyPolicy,
} from "../../api/agent-concurrency";
import { AGENT_CONCURRENCY_NS } from "../../i18n/namespace";

const dimensions = ["agentMaxConcurrency", "userAgentMaxConcurrency", "scheduledAgentMaxConcurrency"] as const;
type Draft = Record<keyof ConcurrencyPolicyView, string>;
const blank: Draft = { agentMaxConcurrency: "", userAgentMaxConcurrency: "", scheduledAgentMaxConcurrency: "" };
function draftOf(policy: ConcurrencyPolicyView): Draft {
  return {
    agentMaxConcurrency: policy.agentMaxConcurrency.override?.toString() ?? "",
    userAgentMaxConcurrency: policy.userAgentMaxConcurrency.override?.toString() ?? "",
    scheduledAgentMaxConcurrency: policy.scheduledAgentMaxConcurrency.override?.toString() ?? "",
  };
}
function parseLimit(value: string): number | null {
  if (!value.trim()) return null;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 2147483647) throw new Error("invalidLimit");
  return result;
}

/** 系统密钥保护的动态并发管理页，不读取或展示临时实例。 */
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
  const [draft, setDraft] = useState<Draft>(blank);
  const [userId, setUserId] = useState("");
  const [userLimit, setUserLimit] = useState("");
  const [selected, setSelected] = useState<UserConcurrencyPolicy>();
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
    { onSuccess: ({ policy }) => setDraft(draftOf(policy)), onError: handleError },
  );
  const disabled = busy || query.loading;
  const run = async (operation: () => Promise<void>, saved = true) => {
    setBusy(true);
    setFeedback("");
    setMutationError("");
    try {
      await operation();
      if (saved) {
        setFeedback(t("saved"));
        try {
          await query.refreshAsync();
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          // useRequest 保留刷新错误供页面展示，已提交的写入仍显示成功。
          handleError(error);
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      handleError(error);
      setMutationError(error.message === "invalidLimit" ? t("invalidLimit") : error.message);
    } finally {
      setBusy(false);
    }
  };
  const saveGlobal = (reset = false) =>
    run(async () => {
      const patch: ConcurrencyPatch = {};
      for (const key of dimensions) patch[key] = reset ? null : parseLimit(draft[key]);
      const committed = await agentConcurrencyApi.patchGlobal(patch);
      // 写响应是已提交状态；后续刷新失败不能把用户重新带回旧覆盖。
      query.mutate((current) => ({ policy: committed, users: current?.users ?? [] }));
      setDraft(draftOf(committed));
      setSelected(undefined);
    });
  const policy = query.data?.policy;
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6" aria-busy={disabled}>
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setSelected(undefined);
            query.refresh();
          }}
        >
          {t("retry")}
        </Button>
      </header>
      {query.loading && <p role="status">{t("loading")}</p>}
      {query.error && (
        <p role="alert">{query.data ? t("refreshFailed", { message: query.error.message }) : query.error.message}</p>
      )}
      {mutationError && <p role="alert">{mutationError}</p>}
      {feedback && <p role="status">{feedback}</p>}
      {policy && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("global")}</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveGlobal();
                }}
              >
                {dimensions.map((key) => (
                  <div key={key} className="grid gap-2 sm:grid-cols-2">
                    <label htmlFor={`concurrency-${key}`}>
                      {t(key)}
                      <Input
                        id={`concurrency-${key}`}
                        aria-describedby={`effective-${key}`}
                        type="number"
                        min={1}
                        max={2147483647}
                        step={1}
                        value={draft[key]}
                        placeholder={t("inherit")}
                        disabled={disabled}
                        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      />
                    </label>
                    <p className="self-end text-sm" id={`effective-${key}`}>
                      {t("effective")}: {policy[key].value ?? t("unlimited")} · {t(`sources.${policy[key].source}`)}
                    </p>
                  </div>
                ))}
                <p className="text-sm text-muted-foreground">{t("inheritHelp")}</p>
                <div className="flex gap-2">
                  <Button type="submit" disabled={disabled}>
                    {t("save")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      void saveGlobal(true);
                    }}
                  >
                    {t("reset")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("users")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    const user = await agentConcurrencyApi.putUser(userId.trim(), parseLimit(userLimit));
                    setSelected(user);
                  });
                }}
              >
                <label htmlFor="concurrency-user-id">
                  {t("userId")}
                  <Input
                    id="concurrency-user-id"
                    required
                    value={userId}
                    disabled={disabled}
                    onChange={(event) => {
                      setUserId(event.target.value);
                      setSelected(undefined);
                      setUserLimit("");
                    }}
                  />
                </label>
                <label htmlFor="concurrency-user-limit">
                  {t("userLimit")}
                  <Input
                    id="concurrency-user-limit"
                    type="number"
                    min={1}
                    max={2147483647}
                    step={1}
                    value={userLimit}
                    placeholder={t("inherit")}
                    disabled={disabled}
                    onChange={(event) => setUserLimit(event.target.value)}
                  />
                </label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || !userId.trim()}
                    onClick={() => {
                      void run(async () => {
                        const user = await agentConcurrencyApi.getUser(userId.trim());
                        setSelected(user);
                        setUserLimit(user.policy.userAgentMaxConcurrency.override?.toString() ?? "");
                      }, false);
                    }}
                  >
                    {t("loadUser")}
                  </Button>
                  <Button type="submit" disabled={disabled || !userId.trim()}>
                    {t("saveUser")}
                  </Button>
                </div>
                {selected && (
                  <p>
                    {selected.name} · {t("effective")}:{" "}
                    {selected.policy.userAgentMaxConcurrency.value ?? t("unlimited")} ·{" "}
                    {t(`sources.${selected.policy.userAgentMaxConcurrency.source}`)}
                  </p>
                )}
              </form>
              {query.data?.users.length === 0 ? (
                <p>{t("empty")}</p>
              ) : (
                <ul className="space-y-2">
                  {query.data?.users.map((user) => (
                    <li key={user.userId} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                      <span>
                        {user.name} ({user.userId}) · {t("effective")}:{" "}
                        {user.policy.userAgentMaxConcurrency.value ?? t("unlimited")} ·{" "}
                        {t(`sources.${user.policy.userAgentMaxConcurrency.source}`)}
                      </span>
                      <Button
                        variant="outline"
                        disabled={disabled}
                        aria-label={t("deleteUser", { name: user.name })}
                        onClick={() => {
                          void run(async () => {
                            const inherited = await agentConcurrencyApi.deleteUser(user.userId);
                            if (selected?.userId === user.userId) {
                              setSelected(inherited);
                              setUserLimit("");
                            }
                          });
                        }}
                      >
                        {t("delete")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
