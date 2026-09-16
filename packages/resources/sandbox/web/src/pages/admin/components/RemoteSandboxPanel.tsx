import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type ClusterServer, type RemoteSandbox, systemSandboxApi } from "../../../api/system-sandbox";

type RemoteSandboxPanelProps = {
  server: ClusterServer;
  onAuthFailure?: () => void;
};

type CommandEvent = { type?: string; text?: string; [key: string]: unknown };

function getImageName(sandbox: RemoteSandbox): string {
  if (typeof sandbox.image === "string") return sandbox.image;
  if (sandbox.image && typeof sandbox.image.uri === "string") return sandbox.image.uri;
  return "-";
}

function getCommandEventText(event: CommandEvent): string {
  if (typeof event.text === "string") return event.text;
  if (typeof event.data === "string") return event.data;
  return JSON.stringify(event);
}

function formatRemoteTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function RemoteSandboxPanel({ server, onAuthFailure }: RemoteSandboxPanelProps) {
  const { t } = useTranslation("observer");
  const [expanded, setExpanded] = useState(false);
  const [sandboxes, setSandboxes] = useState<RemoteSandbox[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RemoteSandbox | null>(null);
  const [commandTarget, setCommandTarget] = useState<RemoteSandbox | null>(null);
  const [detail, setDetail] = useState<RemoteSandbox | null>(null);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [commandOutput, setCommandOutput] = useState<string[]>([]);
  const [commandRunning, setCommandRunning] = useState(false);
  const [confirmCommand, setConfirmCommand] = useState(false);
  const [commandAbort, setCommandAbort] = useState<AbortController | null>(null);

  const loadSandboxes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await systemSandboxApi.server.listSandboxes(server.id, { state: "Running" });
      setSandboxes(result.items);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("sandbox.remoteLoadError");
      setError(message);
      if (message.toLowerCase().includes("unauthorized")) onAuthFailure?.();
    } finally {
      setLoading(false);
    }
  }, [onAuthFailure, server.id, t]);

  useEffect(() => {
    if (expanded) void loadSandboxes();
  }, [expanded, loadSandboxes]);

  const openDetail = async (sandbox: RemoteSandbox) => {
    setSelected(sandbox);
    setDetail(null);
    setDiagnostics(null);
    try {
      const [sandboxDetail, diagnosticText] = await Promise.all([
        systemSandboxApi.server.getSandbox(server.id, sandbox.id),
        systemSandboxApi.server.getDiagnostics(server.id, sandbox.id),
      ]);
      setDetail(sandboxDetail);
      setDiagnostics(diagnosticText);
    } catch (cause) {
      toast.error(t("sandbox.remoteDetailError"), { description: cause instanceof Error ? cause.message : undefined });
    }
  };

  const openCommand = (sandbox: RemoteSandbox) => {
    setSelected(null);
    setCommandTarget(sandbox);
    setCommandOpen(true);
  };

  const runCommand = async () => {
    if (!commandTarget || !command.trim()) return;
    const controller = new AbortController();
    setCommandAbort(controller);
    setCommandRunning(true);
    setCommandOutput([]);
    try {
      const response = await systemSandboxApi.server.executeCommand(
        server.id,
        commandTarget.id,
        { command: command.trim(), ...(cwd.trim() ? { cwd: cwd.trim() } : {}), background: false, timeout: 30_000 },
        controller.signal,
      );
      if (!response.body) throw new Error(t("sandbox.commandStreamMissing"));
      for await (const event of readSseEvents(response.body)) {
        const text = getCommandEventText(event);
        if (event.type === "stderr" || event.type === "error")
          setCommandOutput((current) => [...current, `[stderr] ${text}`]);
        else if (event.type !== "ping" && event.type !== "init") setCommandOutput((current) => [...current, text]);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        toast.error(t("sandbox.commandError"), { description: cause instanceof Error ? cause.message : undefined });
      }
    } finally {
      setCommandRunning(false);
      setCommandAbort(null);
    }
  };

  return (
    <>
      <div className="mt-2 rounded border border-dashed border-border bg-muted/10">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span>{t("sandbox.remoteSandboxes")}</span>
          <span className="text-text-muted">{expanded ? sandboxes.length : ""}</span>
          <span className="ml-auto text-text-muted">
            {expanded ? t("sandbox.collapseHint") : t("sandbox.expandHint")}
          </span>
        </button>
        {expanded ? (
          <div className="space-y-2 border-t border-border p-3">
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => void loadSandboxes()} disabled={loading}>
                <RefreshCw className="size-3.5" />
                {t("sandbox.refreshRemoteSandboxes")}
              </Button>
            </div>
            {loading ? <p className="text-xs text-text-muted">{t("states.loading")}</p> : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {!loading && !error && sandboxes.length === 0 ? (
              <p className="text-xs text-text-muted">{t("sandbox.remoteSandboxesEmpty")}</p>
            ) : null}
            {sandboxes.map((sandbox) => (
              <div
                key={sandbox.id}
                className="flex min-w-0 flex-wrap items-center gap-3 rounded border border-border bg-background p-2 text-xs"
              >
                <div className="min-w-0 space-y-1">
                  <div className="min-w-0 break-all">
                    <b>{t("sandbox.instanceId")}：</b>
                    <span className="font-mono">{sandbox.id}</span>
                  </div>
                  <div className="break-all">
                    <b>{t("sandbox.image")}：</b>
                    <span className="font-mono">{getImageName(sandbox)}</span>
                  </div>
                </div>
                <div className="min-w-0 space-y-1">
                  <div>
                    <b>{t("sandbox.createdAt")}：</b>
                    <span>{formatRemoteTime(sandbox.createdAt)}</span>
                  </div>
                  <div>
                    <b>{t("sandbox.lastStartedAt")}：</b>
                    <span>{formatRemoteTime(sandbox.status.lastTransitionAt)}</span>
                  </div>
                </div>
                <Badge className="shrink-0" variant={sandbox.status.state === "Running" ? "secondary" : "outline"}>
                  {sandbox.status.state}
                </Badge>
                <span className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
                  <Button size="sm" variant="outline" onClick={() => void openDetail(sandbox)}>
                    {t("sandbox.detail")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openCommand(sandbox)}>
                    {t("sandbox.executeCommand")}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent
          className="max-h-[85vh] overflow-y-auto"
          style={{ width: "min(96vw, 90rem)", maxWidth: "90rem" }}
        >
          <DialogHeader>
            <DialogTitle>{selected ? `${t("sandbox.remoteSandboxDetail")} · ${selected.id}` : ""}</DialogTitle>
          </DialogHeader>
          {selected ? (
            <div className="min-w-0 space-y-4">
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                {JSON.stringify(detail ?? selected, null, 2)}
              </pre>
              {diagnostics !== null ? (
                <div>
                  <Label>{t("sandbox.diagnostics")}</Label>
                  <Textarea readOnly value={diagnostics} className="mt-1 min-h-64 font-mono text-xs" />
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>
              {t("sandbox.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={commandOpen}
        onOpenChange={(open) => {
          if (!open && !commandRunning) {
            setCommandOpen(false);
            setCommandTarget(null);
          }
        }}
      >
        <DialogContent
          className="max-h-[85vh] overflow-y-auto"
          style={{ width: "min(96vw, 72rem)", maxWidth: "72rem" }}
        >
          <DialogHeader>
            <DialogTitle>{t("sandbox.executeCommand")}</DialogTitle>
          </DialogHeader>
          <div className="min-w-0 space-y-3">
            <div>
              <Label htmlFor="remote-command">{t("sandbox.command")}</Label>
              <Input
                id="remote-command"
                className="w-full"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                disabled={commandRunning}
              />
            </div>
            <div>
              <Label htmlFor="remote-command-cwd">{t("sandbox.cwd")}</Label>
              <Input
                id="remote-command-cwd"
                className="w-full"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                disabled={commandRunning}
                placeholder="/workspace"
              />
            </div>
            <Textarea
              readOnly
              value={commandOutput.join("\n")}
              className="min-h-48 w-full bg-background font-mono text-xs text-foreground"
            />
          </div>
          <DialogFooter>
            {commandRunning ? (
              <Button variant="destructive" onClick={() => commandAbort?.abort()}>
                {t("sandbox.cancelCommand")}
              </Button>
            ) : (
              <Button variant="destructive" disabled={!command.trim()} onClick={() => setConfirmCommand(true)}>
                {t("sandbox.executeCommand")}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={commandRunning}
              onClick={() => {
                setCommandOpen(false);
                setCommandTarget(null);
              }}
            >
              {t("sandbox.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmCommand}
        onOpenChange={setConfirmCommand}
        title={t("sandbox.confirmExecuteCommandTitle")}
        description={t("sandbox.confirmExecuteCommandDescription", { command: command.trim() })}
        confirmLabel={t("sandbox.executeCommand")}
        variant="destructive"
        onConfirm={() => {
          setConfirmCommand(false);
          void runCommand();
        }}
      />
    </>
  );
}

export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<CommandEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        yield* parseCommandEventBlock(chunk);
      }
      if (result.done) {
        if (buffer.trim()) yield* parseCommandEventBlock(buffer);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function* parseCommandEventBlock(block: string): Generator<CommandEvent> {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  const candidates = data ? [data] : lines.filter((line) => !line.startsWith("event:") && !line.startsWith(":"));
  for (const candidate of candidates) {
    try {
      yield JSON.parse(candidate) as CommandEvent;
    } catch {
      yield { type: "stdout", text: candidate };
    }
  }
}
