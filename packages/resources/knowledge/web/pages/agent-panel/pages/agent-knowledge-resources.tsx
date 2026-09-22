import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Switch } from "@fenix/ui-components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import {
  ExternalLink,
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { KnowledgeResourceInfo } from "../../../types/knowledge";
import { KB_STATUS_TONES, kbStatusLabel } from "./knowledge-status";

interface AgentKnowledgeResourcesProps {
  resources: KnowledgeResourceInfo[];
  canManage: boolean;
  uploading: boolean;
  deletingResourceId: string | null;
  reparsingResourceId: string | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFilesSelected: (files: File[]) => void;
  onOpenChunks: (resource: KnowledgeResourceInfo) => void;
  onToggleEnabled: (resource: KnowledgeResourceInfo, enabled: boolean) => void;
  onReparse: (resource: KnowledgeResourceInfo) => void;
  onPreview: (resource: KnowledgeResourceInfo) => void;
  onDelete: (resource: KnowledgeResourceInfo) => void;
}

function formatTimestamp(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Date(timestamp * 1000).toLocaleString();
}

function FileIcon({ filename }: { filename: string }) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return <FileImage />;
  if (["pdf", "docx", "doc"].includes(ext)) return <FileText />;
  if (["xlsx", "xls", "csv"].includes(ext)) return <FileSpreadsheet />;
  if (["pptx", "ppt"].includes(ext)) return <Presentation />;
  if (["md", "txt", "json", "xml", "yaml", "yml", "html", "js", "ts", "tsx", "py", "go", "rs", "sh"].includes(ext))
    return <FileCode />;
  return <File />;
}

export function AgentKnowledgeResources(props: AgentKnowledgeResourcesProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  return (
    <section className="knowledge-resources">
      <header className="knowledge-resources__header">
        <h3>{t("resources.title", { count: props.resources.length })}</h3>
        <input
          ref={props.fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = event.target.files ? Array.from(event.target.files) : [];
            if (files.length) props.onFilesSelected(files);
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={props.uploading || !props.canManage}
          onClick={() => props.fileInputRef.current?.click()}
        >
          <Upload />
          {props.uploading ? t("btn.uploading") : t("btn.upload")}
        </Button>
      </header>
      {props.resources.length === 0 ? (
        <div className="knowledge-resources__empty">
          <File />
          <strong>{t("resources.empty")}</strong>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead className="text-center">{t("resources.colChunks")}</TableHead>
              <TableHead>{t("resources.colStatus")}</TableHead>
              <TableHead className="text-center">{t("resources.colEnabled")}</TableHead>
              <TableHead>{t("columns.updatedAt")}</TableHead>
              <TableHead className="text-right">{t("resources.colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.resources.map((resource) => (
              <TableRow key={resource.id}>
                <TableCell>
                  <div className="knowledge-resource-name">
                    <span className="knowledge-resource-name__icon">
                      <FileIcon filename={resource.sourceName} />
                    </span>
                    {resource.chunkCount != null && resource.chunkCount > 0 ? (
                      <button type="button" onClick={() => props.onOpenChunks(resource)} title={resource.sourceName}>
                        {resource.sourceName}
                      </button>
                    ) : (
                      <strong title={resource.sourceName}>{resource.sourceName}</strong>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-center text-[#8090a7]">{resource.chunkCount ?? "—"}</TableCell>
                <TableCell>
                  {resource.runStatus === "RUNNING" && resource.parseProgress != null ? (
                    <div className="knowledge-resource-progress">
                      <span
                        className="knowledge-resource-progress__bar"
                        style={{ width: `${Math.round(resource.parseProgress * 100)}%` }}
                      />
                      <small>{Math.round(resource.parseProgress * 100)}%</small>
                    </div>
                  ) : (
                    // 状态胶囊此前是本包手写的 `.knowledge-resource-status.is-*` 色表（还带一份逐字
                    // 相同的 `statusClass` 副本），改由库的 StatusBadge 承担配色；文案随之与详情头部
                    // 同口径走字典（原先这里直接上屏后端原文 `ready`，中文界面里另一处写「就绪」）。
                    <StatusBadge
                      status={resource.status}
                      label={kbStatusLabel(t, resource.status)}
                      toneMap={KB_STATUS_TONES}
                      indicator="dot"
                    />
                  )}
                </TableCell>
                <TableCell className="text-center">
                  <Switch
                    checked={resource.enabled ?? true}
                    disabled={!props.canManage}
                    onCheckedChange={(checked) => props.onToggleEnabled(resource, checked)}
                  />
                </TableCell>
                <TableCell className="text-[#8090a7]">{formatTimestamp(resource.createdAt)}</TableCell>
                <TableCell>
                  <div className="knowledge-resource-actions">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!props.canManage || props.reparsingResourceId === resource.id}
                      onClick={() => props.onReparse(resource)}
                    >
                      <RefreshCw className={props.reparsingResourceId === resource.id ? "animate-spin" : ""} />
                      {t("reparse.btn")}
                    </Button>
                    {resource.status === "ready" && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title={t("preview.btn")}
                        aria-label={t("preview.btn")}
                        onClick={() => props.onPreview(resource)}
                      >
                        <ExternalLink />
                      </Button>
                    )}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-red-500"
                      title={t("actions.delete")}
                      aria-label={t("actions.delete")}
                      disabled={!props.canManage || props.deletingResourceId === resource.id}
                      onClick={() => props.onDelete(resource)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
