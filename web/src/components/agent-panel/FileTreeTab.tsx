import { useRequest } from "ahooks";
import {
  Download,
  Folder,
  FolderInput,
  FolderOpen,
  FolderTree,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { forwardRef, type ReactNode, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { NodeState, TreeNodeData } from "@/components/ui/tree";
import { Tree } from "@/components/ui/tree";
import { buildUploadUrl, fsApi, MAX_UPLOAD_SIZE_BYTES } from "@/src/api/fs";
import { ApiError, UPLOAD_TIMEOUT_MS, unwrap } from "@/src/api/request";
import { FileTypeIcon } from "@/src/components/file-icon-helper";
import { NS } from "../../i18n";
import { buildPreviewUrl, encodePathSegment } from "./preview/utils";

interface FileTreeTabProps {
  envId: string | null;
  onPreviewFile: (path: string) => void;
  onReferenceFile: (path: string, name: string) => void;
}

// 扁平路径 → 层级结构解析
interface ParsedNode {
  name: string;
  path: string;
  isDir: boolean;
  children: ParsedNode[];
}

function parsePathsToTree(paths: string[]): ParsedNode[] {
  const root: ParsedNode[] = [];

  for (const rawPath of paths) {
    const isDir = rawPath.endsWith("/");
    const cleanPath = isDir ? rawPath.slice(0, -1) : rawPath;
    const parts = cleanPath.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const thisIsDir = isLast ? isDir : true;
      const thisPath = parts.slice(0, i + 1).join("/");

      let existing = current.find((n) => n.name === part);
      if (!existing) {
        existing = { name: part, path: thisPath, isDir: thisIsDir, children: [] };
        current.push(existing);
      }
      current = existing.children;
    }
  }

  // 排序：目录在前，文件在后，各自按名字排序
  const sortNodes = (nodes: ParsedNode[]): ParsedNode[] => {
    return nodes
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((n) => ({ ...n, children: sortNodes(n.children) }));
  };

  return sortNodes(root);
}

function parsedToTreeNodeData(node: ParsedNode): TreeNodeData {
  return {
    id: node.path,
    label: node.name,
    hasChildren: node.isDir && node.children.length > 0,
  };
}

/**
 * 额外传递原始文件名，兼容 Bun multipart 解析器丢失 0 字节文件名的情况。
 */
function appendUploadFileNames(formData: FormData, files: File[]): void {
  formData.append("fileNames", JSON.stringify(files.map((file) => file.name)));
}

/** 上传大小上限的展示文案（由 MAX_UPLOAD_SIZE_BYTES 派生，避免与硬编码漂移） */
const MAX_SIZE_LABEL = `${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB`;

/** 工具栏按钮：点击后压制 tooltip，鼠标真正离开再重新进入后才恢复 */
function ToolbarTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const suppressRef = useRef(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(v) => {
        if (suppressRef.current && v) return;
        setOpen(v);
      }}
    >
      <TooltipTrigger asChild>
        <span
          onPointerDown={() => {
            suppressRef.current = true;
            setOpen(false);
          }}
          onPointerEnter={() => {
            suppressRef.current = false;
          }}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export interface FileTreeTabHandle {
  uploadFiles: (files: File[], onProgress?: (percent: number) => void) => Promise<void>;
}

export const FileTreeTab = forwardRef<FileTreeTabHandle, FileTreeTabProps>(function FileTreeTab(
  { envId, onPreviewFile, onReferenceFile },
  ref,
) {
  const { t } = useTranslation(NS.COMPONENTS);
  const { t: tPanel } = useTranslation(NS.AGENT_PANEL);
  const treeDataRef = useRef<ParsedNode[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [selectedDir, setSelectedDir] = useState<string | undefined>(undefined);
  const expandedIdsRef = useRef<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{ path: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // 加载失败时保留旧树并展示过期横幅（文件服务不可用 ≠ 空目录，docs/arch/12-files.md §7.3）
  const [stale, setStale] = useState(false);

  // 用最新树数据替换当前树：加载/重校验共用，成功后同时清除过期横幅
  const applyTree = useCallback((paths: string[], mtimes?: Record<string, number>) => {
    // 按文件修改时间倒序排列（最新上传的在前）
    const sorted = [...paths].sort((a, b) => (mtimes?.[b] ?? 0) - (mtimes?.[a] ?? 0));
    treeDataRef.current = parsePathsToTree(sorted);
    setStale(false);
    setTreeVersion((v) => v + 1);
  }, []);

  // ── 文件树加载 ──
  const { loading, refresh: refreshTree } = useRequest(() => unwrap(fsApi.tree(envId!)), {
    ready: !!envId,
    onSuccess: (data) => {
      applyTree(data?.paths ?? [], data?.mtimes);
    },
    onError: (err) => {
      console.error("Failed to load file tree:", err);
      // 失败不清空旧树：断连/降级期间继续展示上次数据 + 过期横幅，禁止渲染为空目录
      setStale(true);
    },
  });

  // ── 文件上传 ──
  const { run: runUpload, loading: uploading } = useRequest(
    (fd: FormData, targetDir?: string) => unwrap(fsApi.upload(envId!, fd, targetDir)),
    {
      manual: true,
      onSuccess: (data) => {
        toast.success(t("fileTree.uploadSuccess", { count: data.files?.length ?? 0 }));
        refreshTree();
      },
      onError: (err) => {
        if (err instanceof ApiError && (err as ApiError & { status?: number }).status === 413) {
          toast.error(t("filePicker.uploadTooLarge"));
        } else {
          toast.error(err.message || t("fileTree.uploadFailed"));
        }
      },
    },
  );

  // ── 重命名 ──
  const { run: runRename } = useRequest(
    (oldPath: string, newName: string) => {
      const parentDir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : "";
      const newPath = parentDir ? `${parentDir}/${newName}` : newName;
      return unwrap(fsApi.rename(envId!, oldPath, newPath));
    },
    {
      manual: true,
      onSuccess: () => refreshTree(),
      onError: (err) => {
        console.error("Rename failed:", err);
        toast.error(err.message || t("fileTree.renameFailed"));
      },
    },
  );

  // ── 删除 ──
  const { run: runDelete } = useRequest((path: string) => unwrap(fsApi.batchDelete(envId!, [path])), {
    manual: true,
    onSuccess: (data) => {
      const failed = (data as { failed?: Array<{ path: string; error: string }> } | undefined)?.failed;
      if (failed && failed.length > 0) {
        toast.error(failed[0].error || t("fileTree.contextMenu.delete"));
        return;
      }
      setDeleteConfirm(null);
      refreshTree();
    },
    onError: (err) => {
      console.error("Delete failed:", err);
      toast.error(t("fileTree.contextMenu.delete"));
    },
  });

  // ── 创建目录 ──
  const { run: runMkdir } = useRequest((path: string) => unwrap(fsApi.mkdir(envId!, path)), {
    manual: true,
    onSuccess: () => refreshTree(),
    onError: (err) => {
      console.error("Mkdir failed:", err);
      toast.error(err.message || t("fileTree.mkdirFailed"));
    },
  });

  // ── 创建新文件 ──
  const { run: runNewFile } = useRequest((path: string) => unwrap(fsApi.writeFile(envId!, path, "")), {
    manual: true,
    onSuccess: () => refreshTree(),
    onError: (err) => {
      console.error("New file failed:", err);
      toast.error(err.message || t("fileTree.newFileFailed"));
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      uploadFiles: async (files: File[], onProgress?: (percent: number) => void) => {
        if (!envId || files.length === 0) return;

        // 客户端补齐总上传量校验（外部直接调 ref 方法时也需要）
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        if (totalSize > MAX_UPLOAD_SIZE_BYTES) {
          const sizeStr =
            totalSize > 1024 * 1024 * 1024
              ? `${(totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB`
              : `${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
          toast.error(t("filePicker.totalTooLarge", { total: sizeStr, max: MAX_SIZE_LABEL }));
          return;
        }

        const targetDir = selectedDir || "";
        const formData = new FormData();
        for (const file of files) {
          formData.append("files", file);
        }
        appendUploadFileNames(formData, files);

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          // 未选中目录（targetDir 为空）时上传到 workspace 根：必须保留尾斜杠（/fs/），
          // 否则 Elysia splat 路由不匹配空段返回 404；与 fsApi.upload 共用同一拼装逻辑
          const url = buildUploadUrl(envId, targetDir);
          // 写操作幂等契约的 HTTP 载体：每次上传生成一个 opId，超时/断网后调用方重发可被服务端去重
          const opId = crypto.randomUUID();

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
              onProgress(Math.round((e.loaded / e.total) * 100));
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              reject(new Error(`Upload failed: ${xhr.status}`));
            }
          };

          xhr.onerror = () => reject(new Error("Upload network error"));
          // 超时与后端 upload 120s 对齐：慢网络不提前掐断（docs/arch/12-files.md §10 P1-12 D19）
          xhr.timeout = UPLOAD_TIMEOUT_MS;
          xhr.ontimeout = () => reject(new Error("Upload timeout"));
          xhr.open("POST", url);
          xhr.withCredentials = true;
          xhr.setRequestHeader("x-file-op-id", opId);
          xhr.send(formData);
        });

        refreshTree();
      },
    }),
    [envId, selectedDir, refreshTree, t],
  );

  // ── 过期重校验与变更订阅（docs/arch/12-files.md §4.1/§4.3）──
  // 可见性恢复 / invalidate_all / 订阅重连成功时，带 If-None-Match（上次 ETag）重拉；
  // 304 表示无变化，不重挂树。request() 不透传响应头，故此处用原生 fetch（与下载同模式），
  // ETag 从重校验响应头累积（W13' 服务端 ETag 上线前恒为 200，自动退化为无条件重拉）。
  const etagRef = useRef<string | null>(null);
  const revalidateTimerRef = useRef<number | null>(null);
  const lastRevalidateAtRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(false);

  // 带 If-None-Match 的树重校验：200 全量替换并更新 ETag，304 跳过，失败保留旧树 + 过期横幅
  const revalidateTree = useCallback(async () => {
    if (!envId) return;
    // 消费者侧 coalescing：同一环境 30s 窗口内多次失效帧合并为一次重拉（§4.3）
    const now = Date.now();
    if (now - lastRevalidateAtRef.current < 30_000) return;
    lastRevalidateAtRef.current = now;
    try {
      const headers: Record<string, string> = {};
      if (etagRef.current) headers["If-None-Match"] = etagRef.current;
      const res = await fetch(`/web/environments/${encodeURIComponent(envId)}/fs/tree`, {
        credentials: "include",
        headers,
      });
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`Tree revalidate failed: ${res.status}`);
      const json = (await res.json()) as {
        success?: boolean;
        data?: { paths?: string[]; mtimes?: Record<string, number> };
      };
      if (json.success === false) throw new Error("Tree revalidate rejected");
      etagRef.current = res.headers.get("etag");
      applyTree(json.data?.paths ?? [], json.data?.mtimes);
    } catch (err) {
      // 重校验失败 = 文件服务不可用：保留旧树并展示过期横幅
      console.error("Failed to revalidate file tree:", err);
      setStale(true);
    }
  }, [envId, applyTree]);

  // 防抖调度：file_changed 按 500ms 合并；invalidate_all / 可见性恢复立即触发（coalescing 兜底）
  const scheduleRevalidate = useCallback(
    (debounceMs: number) => {
      if (revalidateTimerRef.current !== null) window.clearTimeout(revalidateTimerRef.current);
      revalidateTimerRef.current = window.setTimeout(() => {
        revalidateTimerRef.current = null;
        void revalidateTree();
      }, debounceMs);
    },
    [revalidateTree],
  );

  // 建立 /web/file-events 订阅（W4b 端点），断开后指数退避自动重连（3s 起，封顶 30s）
  const connectFileEvents = useCallback(() => {
    if (!envId) return;
    shouldReconnectRef.current = true;
    const existing = wsRef.current;
    if (existing && existing.readyState === WebSocket.OPEN) return;
    if (existing) existing.close();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let url = `${protocol}//${window.location.host}/web/file-events`;
    const activeOrgId = localStorage.getItem("active_org_id");
    if (activeOrgId) url += `?active_org_id=${encodeURIComponent(activeOrgId)}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", environments: [envId] }));
      // 订阅重连成功：断连窗口内的变更未知，强制带 If-None-Match 重校验（§4.1 无订阅窗口上界）
      void revalidateTree();
    };
    ws.onmessage = (e) => {
      let frame: { type?: string; environment_id?: string };
      try {
        frame = JSON.parse(String(e.data)) as { type?: string; environment_id?: string };
      } catch (err) {
        // 非 JSON 帧按协议外输入忽略，保留解析错误便于诊断
        console.error("Invalid file-events frame:", err);
        return;
      }
      if (frame.environment_id !== envId) return;
      if (frame.type === "invalidate_all") {
        scheduleRevalidate(0);
      } else if (frame.type === "file_changed" || frame.type === "file_changed_batch") {
        // 目录粒度局部更新为可选增强；此处统一 500ms 防抖重拉，304 时几乎免费
        scheduleRevalidate(500);
      }
    };
    ws.onclose = () => {
      if (wsRef.current !== ws) return; // 已被新连接或卸载主动替换，不再重连
      wsRef.current = null;
      if (!shouldReconnectRef.current) return;
      const delay = Math.min(3_000 * 2 ** reconnectAttemptRef.current, 30_000);
      reconnectAttemptRef.current++;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connectFileEvents();
      }, delay);
    };
  }, [envId, revalidateTree, scheduleRevalidate]);

  // envId 变化或组件卸载：重建订阅连接（卸载时禁止重连并清理定时器）
  useEffect(() => {
    if (!envId) return;
    connectFileEvents();
    return () => {
      shouldReconnectRef.current = false;
      reconnectAttemptRef.current = 0;
      if (wsRef.current) wsRef.current.close();
      wsRef.current = null;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      if (revalidateTimerRef.current !== null) window.clearTimeout(revalidateTimerRef.current);
      revalidateTimerRef.current = null;
    };
  }, [envId, connectFileEvents]);

  // 页面恢复可见：强制重校验；订阅断开则先重连（重连成功会触发重校验）
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (wsRef.current) {
        scheduleRevalidate(0);
      } else {
        connectFileEvents();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [scheduleRevalidate, connectFileEvents]);

  // 从缓存的 ParsedNode 树中查找指定路径的子节点
  const findChildren = useCallback((parentPath: string | null): ParsedNode[] => {
    if (parentPath === null) return treeDataRef.current;

    const find = (nodes: ParsedNode[]): ParsedNode[] | null => {
      for (const node of nodes) {
        if (node.path === parentPath) return node.children;
        const found = find(node.children);
        if (found) return found;
      }
      return null;
    };

    return find(treeDataRef.current) ?? [];
  }, []);

  const getChildren = useCallback(
    async (parentId: string | null): Promise<TreeNodeData[]> => {
      const children = findChildren(parentId);
      return children.map(parsedToTreeNodeData);
    },
    [findChildren],
  );

  // treeVersion 变化时 Tree 重新挂载，通过 defaultExpandedIds 恢复展开状态
  const handleToggle = useCallback((nodeId: string, expanded: boolean) => {
    if (expanded) {
      expandedIdsRef.current.add(nodeId);
      // 展开目录时同步更新上传目标，使点击 chevron 和点击行展开行为一致
      const parsed = findNodeByPath(treeDataRef.current, nodeId);
      if (parsed?.isDir) {
        setSelectedDir(nodeId);
      }
    } else {
      expandedIdsRef.current.delete(nodeId);
    }
  }, []);

  /** 单击：目录选中，可预览文件触发预览，二进制文件忽略 */
  const handleSelect = useCallback(
    (nodeId: string | null, _node: TreeNodeData) => {
      if (!nodeId) return;
      const parsed = findNodeByPath(treeDataRef.current, nodeId);
      const isDir = parsed?.isDir ?? false;

      if (isDir) {
        setSelectedDir(nodeId);
      } else {
        const parentDir = nodeId.substring(0, nodeId.lastIndexOf("/"));
        setSelectedDir(parentDir || undefined);
        // office/binary 忽略分类检查，统一交给 @open-file-viewer 插件链处理
        onPreviewFile(nodeId);
      }
    },
    [onPreviewFile],
  );

  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    isDir: boolean;
  } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const target = (e.target as HTMLElement).closest("[data-tree-item]");
    if (!target) return;
    const nodeEl = target as HTMLElement;
    const nodeId = nodeEl.querySelector("[data-node-id]")?.getAttribute("data-node-id");
    if (!nodeId) return;
    const node = findNodeByPath(treeDataRef.current, nodeId);
    setContextMenu({ x: e.clientX, y: e.clientY, path: nodeId, isDir: node?.isDir ?? false });
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [contextMenu]);

  const handleReference = useCallback(() => {
    if (!contextMenu) return;
    const name = contextMenu.path.split("/").pop() || contextMenu.path;
    onReferenceFile(contextMenu.path, name);
    setContextMenu(null);
  }, [contextMenu, onReferenceFile]);

  // 拖拽上传
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!envId || !e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      // 客户端提前校验
      const maxSize = MAX_UPLOAD_SIZE_BYTES;
      for (const file of files) {
        if (file.size > maxSize) {
          toast.error(t("filePicker.fileTooLarge", { name: file.name, max: MAX_SIZE_LABEL }));
          return;
        }
      }

      // 校验总上传量
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      if (totalSize > maxSize) {
        const sizeStr =
          totalSize > 1024 * 1024 * 1024
            ? `${(totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB`
            : `${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
        toast.error(t("filePicker.totalTooLarge", { total: sizeStr, max: MAX_SIZE_LABEL }));
        return;
      }

      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }
      appendUploadFileNames(formData, files);
      runUpload(formData, selectedDir);
    },
    [envId, runUpload, selectedDir, t],
  );

  // 按钮上传文件
  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // 按钮上传文件夹
  const handleFolderUploadClick = useCallback(() => {
    folderInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target?.files?.length) {
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      const files = Array.from(e.target.files);

      // 客户端提前校验单文件大小
      const maxSize = MAX_UPLOAD_SIZE_BYTES;
      for (const file of files) {
        if (file.size > maxSize) {
          toast.error(t("filePicker.fileTooLarge", { name: file.name, max: MAX_SIZE_LABEL }));
          if (fileInputRef.current) fileInputRef.current.value = "";
          return;
        }
      }

      // 校验总上传量
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      if (totalSize > maxSize) {
        const sizeStr =
          totalSize > 1024 * 1024 * 1024
            ? `${(totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB`
            : `${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
        toast.error(t("filePicker.totalTooLarge", { total: sizeStr, max: MAX_SIZE_LABEL }));
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }
      appendUploadFileNames(formData, files);
      runUpload(formData, selectedDir);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [runUpload, selectedDir, t],
  );

  const handleFolderInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target?.files?.length) {
        if (folderInputRef.current) folderInputRef.current.value = "";
        return;
      }
      const files = Array.from(e.target.files);

      // 客户端提前校验单文件大小
      const maxSize = MAX_UPLOAD_SIZE_BYTES;
      for (const file of files) {
        if (file.size > maxSize) {
          toast.error(t("filePicker.fileTooLarge", { name: file.name, max: MAX_SIZE_LABEL }));
          if (folderInputRef.current) folderInputRef.current.value = "";
          return;
        }
      }

      // 校验总上传量（文件夹上传最容易触发总量超限）
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      if (totalSize > maxSize) {
        const sizeStr =
          totalSize > 1024 * 1024 * 1024
            ? `${(totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB`
            : `${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
        toast.error(t("filePicker.totalTooLarge", { total: sizeStr, max: MAX_SIZE_LABEL }));
        if (folderInputRef.current) folderInputRef.current.value = "";
        return;
      }

      // webkitRelativePath 保留了文件夹的相对路径结构
      const relativePaths = Array.from(files).map((f) => f.webkitRelativePath || f.name);
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }
      appendUploadFileNames(formData, files);
      formData.append("relativePaths", JSON.stringify(relativePaths));
      runUpload(formData, selectedDir);
      if (folderInputRef.current) folderInputRef.current.value = "";
    },
    [runUpload, selectedDir, t],
  );

  // 下载：文件直接下载，目录打包为 zip
  // 使用 fetch + Blob 确保携带认证 cookie；<a download> 无法保证 credentials
  const handleDownload = useCallback(
    async (nodePath: string, isDir: boolean) => {
      if (!envId) return;
      try {
        let url: string;
        let fileName: string;

        if (isDir) {
          const dirName = nodePath.split("/").filter(Boolean).pop() || "download";
          url = `/web/environments/${envId}/fs/download-zip?path=${encodePathSegment(nodePath)}`;
          fileName = `${dirName}.zip`;
        } else {
          url = buildPreviewUrl(envId, nodePath);
          fileName = nodePath.split("/").pop() || "file";
        }

        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) {
          let errorMessage: string | undefined;
          try {
            const payload: unknown = await res.clone().json();
            if (typeof payload === "object" && payload !== null && "error" in payload) {
              const error = payload.error;
              if (typeof error === "string") {
                errorMessage = error;
              } else if (
                typeof error === "object" &&
                error !== null &&
                "message" in error &&
                typeof error.message === "string"
              ) {
                errorMessage = error.message;
              }
            }
          } catch {
            // 非 JSON 响应没有结构化错误信息，继续使用状态码提示。
          }

          throw new Error(errorMessage || `Download failed: ${res.status}`);
        }
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        toast.error(error instanceof Error && error.message ? error.message : t("fileTree.downloadFailed"));
      }
    },
    [envId, t],
  );

  // per-item 操作：下载 + 删除，hover 时显示
  const renderActions = useCallback(
    (node: TreeNodeData, _state: NodeState) => {
      const parsed = findNodeByPath(treeDataRef.current, node.id);
      const isDir = parsed?.isDir ?? false;

      return (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload(node.id, isDir);
                }}
                className="h-6 w-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary"
              >
                <Download className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{isDir ? t("fileTree.downloadZip") : t("fileTree.download")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteConfirm({ path: node.id, name: node.label });
                }}
                className="h-6 w-6 flex items-center justify-center rounded text-text-muted hover:text-status-error"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("fileTree.contextMenu.delete")}</TooltipContent>
          </Tooltip>
        </>
      );
    },
    [handleDownload, t],
  );

  // 自定义 label：目录用 Folder/FolderOpen 图标，文件用 react-file-icon 按扩展名渲染
  const renderLabel = useCallback((node: TreeNodeData, state: NodeState) => {
    const parsed = findNodeByPath(treeDataRef.current, node.id);
    const isDir = parsed?.isDir ?? false;

    // 目录保持 lucide 图标
    if (isDir) {
      const IconComp = state.expanded ? FolderOpen : Folder;
      return (
        <span className="flex items-center gap-1.5">
          <IconComp className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
          <span className="truncate" title={node.label}>
            {node.label}
          </span>
        </span>
      );
    }

    // 文件使用 react-file-icon 按扩展名显示不同图标
    // ml-6 补偿文件夹 chevron 占位，保持文件图标与文件夹图标左对齐
    return (
      <span className="flex items-center gap-1.5 ml-6">
        <span className="h-4 w-4 flex-shrink-0 inline-flex items-center justify-center">
          <FileTypeIcon filename={node.label ?? ""} />
        </span>
        <span className="truncate" title={node.label}>
          {node.label}
        </span>
      </span>
    );
  }, []);

  const isEmpty = !loading && treeDataRef.current.length === 0;
  // 服务不可用（stale）时始终渲染树区域（旧树或空白 + 横幅），不落入"空目录"空态误导
  const showTree = !!envId && !(isEmpty && !stale);

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full">
      {/* 标题栏 + 工具按钮合并为一行 */}
      <div className="flex items-center justify-between px-2 py-1.5 flex-shrink-0">
        <span className="text-base font-semibold text-text-primary flex items-center gap-1.5">
          <FolderTree className="h-4 w-4" />
          {tPanel("tabFiles")}
        </span>
        <div className="flex items-center gap-1">
          <ToolbarTip label={t("fileTree.refresh")}>
            <button
              type="button"
              onClick={refreshTree}
              disabled={loading || !envId}
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </ToolbarTip>
          <ToolbarTip label={t("fileTree.upload")}>
            <button
              type="button"
              onClick={handleUploadClick}
              disabled={uploading || !envId}
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
            >
              <Upload className="h-4 w-4" />
            </button>
          </ToolbarTip>
          <ToolbarTip label={t("fileTree.uploadFolder")}>
            <button
              type="button"
              onClick={handleFolderUploadClick}
              disabled={uploading || !envId}
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
            >
              <FolderInput className="h-4 w-4" />
            </button>
          </ToolbarTip>
          <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFileInputChange} />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFolderInputChange}
            // @ts-expect-error webkitdirectory is non-standard but widely supported
            webkitdirectory=""
            directory=""
          />
        </div>
      </div>

      {/* 加载失败/服务不可用：保留旧树并显示过期横幅，禁止把失败渲染为空目录 */}
      {stale && (
        <div
          role="status"
          className="flex items-center gap-2 px-3 py-1.5 text-xs text-amber-600 bg-amber-500/10 border-b border-amber-500/20 flex-shrink-0"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{t("fileTree.staleBanner")}</span>
        </div>
      )}

      {/* 文件树 */}
      <div
        className="flex-1 overflow-auto relative"
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={handleContextMenu}
      >
        {dragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg m-2 pointer-events-none">
            <span className="text-sm font-medium text-primary bg-surface-1 px-4 py-2 rounded-lg shadow">
              {t("fileTree.dropToUpload")}
            </span>
          </div>
        )}
        {showTree ? (
          <Tree
            key={treeVersion}
            getChildren={getChildren}
            defaultExpandedIds={[...expandedIdsRef.current]}
            onSelect={handleSelect}
            onToggle={handleToggle}
            renderActions={renderActions}
            renderLabel={renderLabel}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
            <Folder className="h-8 w-8 text-text-muted/40" />
            <p className="text-sm text-text-muted">{t("fileTree.emptyState")}</p>
            <p className="text-xs text-text-muted/60 text-center max-w-[200px]">{t("fileTree.emptyHint")}</p>
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="fixed rounded-lg border border-border bg-surface-1 p-1 shadow-lg min-w-[160px] z-50"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-text-primary hover:bg-surface-2"
            onClick={handleReference}
          >
            {t("fileTree.contextMenu.reference")}
          </button>
          {!contextMenu.isDir && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-text-primary hover:bg-surface-2"
              onClick={() => {
                const currentName = contextMenu.path.split("/").pop() ?? "";
                const newName = window.prompt(t("fileTree.contextMenu.rename"), currentName);
                if (!newName || newName === currentName) return;
                runRename(contextMenu.path, newName);
                setContextMenu(null);
              }}
            >
              {t("fileTree.contextMenu.rename")}
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-status-error hover:bg-status-error/10"
            onClick={() => {
              setDeleteConfirm({
                path: contextMenu.path,
                name: contextMenu.path.split("/").pop() ?? contextMenu.path,
              });
              setContextMenu(null);
            }}
          >
            {t("fileTree.contextMenu.delete")}
          </button>
          {contextMenu.isDir && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-text-primary hover:bg-surface-2"
              onClick={() => {
                const name = window.prompt(t("fileTree.contextMenu.newFolderName"));
                if (!name) return;
                runMkdir(`${contextMenu.path}/${name}`);
                setContextMenu(null);
              }}
            >
              {t("fileTree.contextMenu.newFolder")}
            </button>
          )}
          {contextMenu.isDir && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-text-primary hover:bg-surface-2"
              onClick={() => {
                const name = window.prompt(t("fileTree.newFileName"));
                if (!name) return;
                runNewFile(`${contextMenu.path}/${name}`);
                setContextMenu(null);
              }}
            >
              {t("fileTree.newFile")}
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirm(null);
        }}
        title={t("fileTree.contextMenu.delete")}
        description={deleteConfirm?.name ?? ""}
        variant="destructive"
        onConfirm={() => deleteConfirm && runDelete(deleteConfirm.path)}
        confirmLabel={t("fileTree.contextMenu.delete")}
      />
    </div>
  );
});

// 辅助函数：在解析树中查找指定路径的节点
function findNodeByPath(nodes: ParsedNode[], path: string): ParsedNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = findNodeByPath(node.children, path);
    if (found) return found;
  }
  return null;
}
