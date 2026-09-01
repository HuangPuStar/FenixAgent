import { useRequest } from "ahooks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { mcpApi } from "@/src/api/mcp";
import { unwrap } from "@/src/api/request";
import { NS } from "../../../i18n";
import { canManageMcpSharing, canWriteMcp, getMcpKey, getMcpLookupKey } from "../../../lib/mcp-resource-access";
import type { McpServerConfig, McpServerInfo, McpToolInfo } from "../../../types/config";
import { AgentMcpCatalog } from "./agent-mcp-catalog";
import { AgentMcpDialog, type McpEditorTarget } from "./agent-mcp-dialog";
import type { McpCatalogScope } from "./agent-mcp-utils";

export function AgentMcpPage() {
  const { t } = useTranslation(NS.MCP);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<McpCatalogScope>("all");
  const [editorTarget, setEditorTarget] = useState<McpEditorTarget>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpServerInfo | null>(null);
  const [inspectingKey, setInspectingKey] = useState<string | null>(null);
  const [toolsByServer, setToolsByServer] = useState<Record<string, McpToolInfo[]>>({});

  const catalog = useRequest(() => unwrap(mcpApi.list()), {
    onError: (error) => {
      console.error(t("toast.loadListFailed"), error);
      toast.error(t("toast.loadListFailedWith", { message: error.message }));
    },
  });
  const servers = catalog.data?.servers ?? [];

  const toggleEnabled = useRequest(
    (server: McpServerInfo) =>
      server.enabled ? unwrap(mcpApi.disable(server.name)) : unwrap(mcpApi.enable(server.name)),
    {
      manual: true,
      onSuccess: () => catalog.refresh(),
      onError: (error) => {
        console.error(t("toast.operationFailed"), error);
        toast.error(t("toast.operationFailedWith", { message: error.message }));
      },
    },
  );

  const deleteServer = useRequest((server: McpServerInfo) => unwrap(mcpApi.del(server.name)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("toast.serverDeleted"));
      setDeleteTarget(null);
      catalog.refresh();
    },
    onError: (error) => {
      console.error(t("toast.deleteFailed"), error);
      toast.error(t("toast.deleteFailedWith", { message: error.message }));
    },
  });

  const toggleSharing = useRequest(
    async (server: McpServerInfo) => {
      if (!canManageMcpSharing(server) || !server.resourceAccess) throw new Error(t("errors.sharingUnavailable"));
      const nextPublicReadable = !server.resourceAccess.publicReadable;
      const detail = await unwrap(mcpApi.get(getMcpLookupKey(server)));
      await unwrap(
        mcpApi.update(server.name, {
          ...detail.config,
          publicReadable: nextPublicReadable,
        } as McpServerConfig),
      );
      return nextPublicReadable;
    },
    {
      manual: true,
      onSuccess: (publicReadable) => {
        toast.success(publicReadable ? tComponents("resource.makePublic") : tComponents("resource.makePrivate"));
        catalog.refresh();
      },
      onError: (error) => {
        console.error(t("toast.saveFailed"), error);
        toast.error(t("toast.saveFailedWith", { message: error.message }));
      },
    },
  );

  const inspectServer = async (server: McpServerInfo) => {
    const key = getMcpKey(server);
    setInspectingKey(key);
    try {
      const tools = canWriteMcp(server)
        ? (await unwrap(mcpApi.inspect(server.name))).tools.map((tool) => ({
            id: `${key}:${tool.name}`,
            toolName: tool.name,
            description: tool.description ?? null,
            inputSchema: (tool.inputSchema ?? null) as Record<string, unknown> | null,
            inspectedAt: Date.now(),
          }))
        : (await unwrap(mcpApi.listTools(server.name))).tools;
      setToolsByServer((current) => ({ ...current, [key]: tools }));
      toast.success(t("toast.inspectSuccessSimple", { count: tools.length }));
      if (canWriteMcp(server)) catalog.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("toast.inspectFailed");
      console.error(t("toast.inspectFailed"), error);
      toast.error(t("toast.inspectFailedWith", { message }));
    } finally {
      setInspectingKey(null);
    }
  };

  return (
    <>
      <AgentMcpCatalog
        servers={servers}
        loading={catalog.loading}
        error={catalog.error}
        query={query}
        scope={scope}
        inspectingKey={inspectingKey}
        sharing={toggleSharing.loading}
        toolsByServer={toolsByServer}
        onQueryChange={setQuery}
        onScopeChange={setScope}
        onCreate={() => setEditorTarget("create")}
        onOpen={setEditorTarget}
        onInspect={(server) => void inspectServer(server)}
        onToggleEnabled={toggleEnabled.run}
        onToggleSharing={toggleSharing.run}
        onDelete={setDeleteTarget}
        onRetry={catalog.refresh}
      />
      <AgentMcpDialog target={editorTarget} onClose={() => setEditorTarget(null)} onSaved={catalog.refresh} />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t("confirm.deleteTitle")}
        description={t("confirm.deleteDescription", {
          name: deleteTarget?.name ?? "",
        })}
        variant="destructive"
        loading={deleteServer.loading}
        onConfirm={() => deleteTarget && deleteServer.run(deleteTarget)}
      />
    </>
  );
}
