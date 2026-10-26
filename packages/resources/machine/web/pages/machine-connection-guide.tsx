import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useTranslation } from "react-i18next";
import { registryApi } from "../api/registry";
import { MACHINE_NS } from "../i18n/namespace";

const engines: Record<string, { name: string; url: string; command: string }> = {
  peri: { name: "Peri", url: "https://github.com/konghayao/peri", command: "peri acp" },
  opencode: { name: "OpenCode", url: "https://opencode.ai/docs/", command: "opencode acp" },
  ccb: { name: "CCB", url: "https://www.npmjs.com/package/claude-code-best", command: "ccb --acp" },
  "claude-code": { name: "Claude Code", url: "https://code.claude.com/docs/en/setup", command: "claude-code" },
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Machine 的本地连接文档：只查询一次公开参数，不跟踪运行状态。 */
export function MachineConnectionGuide({ machineId, organizationId }: { machineId: string; organizationId?: string }) {
  const { t } = useTranslation(MACHINE_NS);
  const { data, loading, error, refresh } = useRequest(
    () => unwrap(registryApi.connectionParameters(machineId, organizationId)),
    {
      refreshDeps: [machineId, organizationId],
      onError: (cause) => console.error("Failed to load Machine connection parameters", cause),
    },
  );
  const engine = data && Object.hasOwn(engines, data.agentType) ? engines[data.agentType] : undefined;
  const command =
    data && engine
      ? [
          `RCS_SECRET=${quote(t("guide.secretPlaceholder"))}`,
          `RCS_URL=${quote(data.rcsUrl)}`,
          `RCS_MACHINE_ID=${quote(data.machineId)}`,
          `AGENT_TYPE=${quote(data.agentType)}`,
          ...(data.agentType === "claude-code" ? ['CLAUDE_CODE_CLI_PATH="$(command -v claude)"'] : []),
          `bun ./acp-runtime.js ${engine.command}`,
        ].join(" ")
      : null;
  return (
    <AppPage busy={loading}>
      <article className="mx-auto w-full max-w-3xl space-y-6">
        <AppHeader title={t("guide.title")} subtitle={t("guide.intro")} />
        {loading ? (
          <p role="status">{t("guide.loading")}</p>
        ) : error ? (
          <div role="alert" className="space-y-3">
            <p>{t("guide.loadError")}</p>
            <p>{error.message}</p>
            <Button onClick={refresh}>{t("guide.retry")}</Button>
          </div>
        ) : data ? (
          <>
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">{t("guide.installTitle")}</h2>
              <p>{t("guide.installHint")}</p>
              <div className="flex flex-wrap gap-4">
                {[
                  { name: "Bun", url: "https://bun.sh/" },
                  { name: "Node.js", url: "https://nodejs.org/en/download" },
                  ...(engine ? [engine] : []),
                ].map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 underline"
                  >
                    {link.name}
                  </a>
                ))}
              </div>
              {data.agentType === "opencode" && (
                <div className="space-y-2">
                  <p>{t("guide.opencodeVersionHint", { version: "1.17.12" })}</p>
                  <code className="break-all">npm install -g opencode-ai@1.17.12</code>
                </div>
              )}
            </section>
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">{t("guide.parametersTitle")}</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <tbody>
                    {[
                      ["RCS_URL", data.rcsUrl],
                      ["RCS_MACHINE_ID", data.machineId],
                      ["AGENT_TYPE", data.agentType],
                      ["RCS_SECRET", t("guide.secretHint")],
                    ].map(([name, value]) => (
                      <tr key={name} className="border-b border-border">
                        <th className="py-2 pr-4 font-mono">{name}</th>
                        <td className="break-all py-2">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>{t("guide.parametersHint")}</p>
            </section>
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">{t("guide.downloadTitle")}</h2>
              <Button asChild>
                <a href="/web/registry/acp-runtime.js" download="acp-runtime.js">
                  {t("guide.download")}
                </a>
              </Button>
              <p>{t("guide.workspaceHint")}</p>
            </section>
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">{t("guide.startTitle")}</h2>
              <p>{t("guide.startHint")}</p>
              {command ? (
                <pre className="overflow-x-auto rounded-lg bg-surface-2 p-4 text-sm">
                  <code>{command}</code>
                </pre>
              ) : (
                <p role="alert">{t("guide.unsupportedEngine")}</p>
              )}
            </section>
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">{t("guide.afterTitle")}</h2>
              <ol className="list-decimal space-y-2 pl-5">
                {[t("guide.keepRunning"), t("guide.selectMachine"), t("guide.startChat"), t("guide.stop")].map(
                  (text) => (
                    <li key={text}>{text}</li>
                  ),
                )}
              </ol>
            </section>
          </>
        ) : null}
      </article>
    </AppPage>
  );
}
