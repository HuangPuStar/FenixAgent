// web/pages/agent-panel/pages/use-knowledge-base-detail.ts
// 知识库**详情与资源**域的状态归属与编排（§3.5 三层拆分的第二层）：选中知识库的详情 / 资源列表、
// 资源上传与同名覆盖、资源的启用开关 / 删除 / 重新解析，以及两段「等解析完成」的轮询。
//
// 从 `AgentKnowledgeBasesPage.tsx` 拆出（§4.7）。域内不读列表域的任何状态，方向只有一条：
// 列表域删掉当前选中的知识库后，经调用方的 `onKnowledgeBaseDeleted` 通知本域清空（见 `clear`）——
// 「被通知」而不是「反向读取」，缝切在这里；渲染所需的字段一律由调用方显式取用。
//
// 路由 `?kbId=` 由页面持有（路由定义不在本包），本 hook 只接收它的当前值与写入函数。

import { unwrap } from "@fenix/web-runtime/api/request";
import { useOrgSession } from "@fenix/web-runtime/contexts/org-session";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { kbApi } from "../../../api/knowledge-bases";
import { type ResourcePollStop, startResourcePolling } from "../../../lib/poll-resources";
import type { KnowledgeBaseDetail, KnowledgeBaseInfo, KnowledgeResourceInfo } from "../../../types/knowledge";
import { getReparseErrorMessage } from "./knowledge-reparse-error";

/** 详情区的 Tab：文档 / 图谱 / 检索测试 */
export type KnowledgeDetailTab = "documents" | "graph" | "retrieval";

interface UseKnowledgeBaseDetailOptions {
  /** 当前选中的知识库 id（路由 `?kbId=`），null 表示未选中 */
  kbId: string | null;
  /** 写入 `?kbId=`：选中（进入详情）与取消选中都经它 */
  pushKbId: (id: string | null) => void;
}

export function useKnowledgeBaseDetail({ kbId, pushKbId }: UseKnowledgeBaseDetailOptions) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const { userId, isOwner } = useOrgSession();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedDetail, setSelectedDetail] = useState<KnowledgeBaseDetail | null>(null);
  const [resources, setResources] = useState<KnowledgeResourceInfo[]>([]);
  const [detailTab, setDetailTab] = useState<KnowledgeDetailTab>("documents");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [deletingResourceId, setDeletingResourceId] = useState<string | null>(null);
  const [resourceDeleteConfirmOpen, setResourceDeleteConfirmOpen] = useState(false);
  const [resourceDeleteTarget, setResourceDeleteTarget] = useState<{
    kbId: string;
    resourceId: string;
    name: string;
  } | null>(null);
  const [reparsingResourceId, setReparsingResourceId] = useState<string | null>(null);
  const [reparseTarget, setReparseTarget] = useState<KnowledgeResourceInfo | null>(null);
  const [reparseConfirmOpen, setReparseConfirmOpen] = useState(false);
  const [reparseDeleteOld, setReparseDeleteOld] = useState(false);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);
  const pendingOverwriteRef = useRef<{ kbId: string; formData: FormData; dupNames: string[] } | null>(null);
  const [previewResource, setPreviewResource] = useState<KnowledgeResourceInfo | null>(null);
  const [selectedChunkResource, setSelectedChunkResource] = useState<KnowledgeResourceInfo | null>(null);

  // 详情查询（手动触发）
  const { run: runLoadDetail, loading: detailLoading } = useRequest(
    (id: string) => Promise.all([unwrap(kbApi.get({ id })), unwrap(kbApi.listResources({ id }))]),
    {
      manual: true,
      onSuccess: ([detail, resList], [requestedId]) => {
        if (requestedId !== kbId) return;
        setSelectedDetail(detail);
        setResources(Array.isArray(resList) ? resList : []);
        setDetailError(null);
      },
      onError: (err, [requestedId]) => {
        if (requestedId !== kbId) return;
        console.error("Failed to load detail", err);
        setSelectedDetail(null);
        setResources([]);
        // 详情失败块的说明同样只取字典（§9.3）：这个状态会渲染进 `KnowledgeLoadFailure` 的失败区，
        // 塞服务端原文等于换了个位置铺内部措辞。
        setDetailError(t("loadDetailError"));
        toast.error(t("loadDetailError"));
      },
    },
  );

  // kbId 变化时自动加载/清除详情（支持浏览器前进后退及直接访问带 kbId 的 URL）
  useEffect(() => {
    setSelectedDetail(null);
    setResources([]);
    setDetailError(null);
    if (kbId) {
      setDetailTab("documents");
      runLoadDetail(kbId);
    }
  }, [kbId, runLoadDetail]);

  // 上传资源
  const { run: runUpload, loading: uploading } = useRequest(
    (id: string, formData: FormData, overwrite?: boolean) => unwrap(kbApi.uploadResources({ id, overwrite }, formData)),
    {
      manual: true,
      onSuccess: (_data, params) => {
        toast.success(t("toast.uploaded"));
        runLoadDetail(params[0]);
        // 上传后异步解析，轮询刷新直到解析完成
        startStatusPoll(params[0]);
      },
      onError: (err) => {
        console.error("Upload failed", err);
        toast.error(t("toast.uploadFailed"));
      },
    },
  );

  /** 轮询句柄由 `startResourcePolling` 给出（调用即停止），两段轮询共用同一个 ref */
  const pollingRef = useRef<ResourcePollStop | null>(null);
  /** 停止当前轮询并清空句柄；重复调用是安全的 */
  const stopStatusPoll = () => {
    pollingRef.current?.();
    pollingRef.current = null;
  };

  /** 上传/重新解析后轮询刷新资源状态，直到所有文档解析完成 */
  const startStatusPoll = (kbId: string) => {
    stopStatusPoll();
    pollingRef.current = startResourcePolling({
      fetchResources: () => unwrap(kbApi.listResources({ id: kbId })),
      onResources: (resList) => setResources(resList),
      // 所有文档都已不在解析中（DONE/FAIL/空），停止轮询
      isSettled: (resList) => !resList.some((r) => r.runStatus === "RUNNING" || r.runStatus === "UNSTART"),
      onSettled: () => runLoadDetail(kbId),
    });
  };

  // 组件卸载时清理轮询
  useEffect(() => {
    return () => {
      pollingRef.current?.();
    };
  }, []);

  // 删除资源
  const { run: runDeleteResource } = useRequest(
    (kbId: string, resourceId: string) => unwrap(kbApi.deleteResource({ kbId, resourceId })),
    {
      manual: true,
      onSuccess: (_data, [kbId]) => {
        toast.success(t("toast.resourceDeleted"));
        setDeletingResourceId(null);
        runLoadDetail(kbId as string);
      },
      onError: (err) => {
        console.error("Delete resource failed", err);
        setDeletingResourceId(null);
        toast.error(t("toast.deleteResourceFailed"));
      },
    },
  );

  // 重新解析轮询：停止条件与「上传后轮询」共用同一份实现，差异只在判据（本次资源是否落定）
  const reparseAndPoll = (kbId: string, resourceId: string) => {
    stopStatusPoll();
    pollingRef.current = startResourcePolling({
      fetchResources: () => unwrap(kbApi.listResources({ id: kbId })),
      onResources: (resList) => setResources(resList),
      isSettled: (resList) => {
        const target = resList.find((r) => r.id === resourceId);
        return !target || target.runStatus === "DONE" || target.runStatus === "FAIL";
      },
      onSettled: (resList) => {
        setReparsingResourceId(null);
        if (resList.some((r) => r.id === resourceId)) runLoadDetail(kbId);
      },
      onError: () => setReparsingResourceId(null),
    });
  };

  // 进入详情
  const handleSelect = (kb: KnowledgeBaseInfo) => {
    if (kb.remoteExists === false) {
      toast.error("该知识库已在 RAGFlow 中被删除，无法查看详情");
      return;
    }
    setDetailTab("documents");
    pushKbId(kb.id);
  };

  /** 重新加载当前详情（失败区与详情头部共用的恢复入口） */
  const reload = () => {
    if (kbId) runLoadDetail(kbId);
  };

  /** 清空详情域（列表域删掉当前选中的知识库时由调用方触发） */
  const clear = useCallback(() => {
    setSelectedDetail(null);
    setResources([]);
    setDetailError(null);
  }, []);

  /**
   * 用后端返回的最新数据同步详情头部（改名 / 改描述后不必重取详情）。
   * 接的是列表域 `kbApi.update` 的返回形状（`KnowledgeBaseInfo`）——它比详情少一个 `recentResources`，
   * 展开时由 `prev` 保留。
   */
  const applyUpdated = (id: string, updated: KnowledgeBaseInfo) => {
    setSelectedDetail((prev) => (prev && prev.id === id ? { ...prev, ...updated } : prev));
  };

  /** 选中文件后先查同名冲突：命中则挂起本次上传，交给覆盖确认弹窗决定走不走 `overwrite` */
  const handleFilesSelected = (files: File[]) => {
    if (!kbId) return;
    const formData = new FormData();
    for (const file of files) formData.append("files", file);
    const existingNames = new Set(resources.map((resource) => resource.sourceName));
    const dupNames = files.map((file) => file.name).filter((name) => existingNames.has(name));
    if (dupNames.length > 0) {
      pendingOverwriteRef.current = { kbId, formData, dupNames };
      setOverwriteConfirmOpen(true);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    runUpload(kbId, formData);
  };

  /** 覆盖确认：把挂起的这次上传按 `overwrite` 重发 */
  const confirmOverwriteUpload = () => {
    const pending = pendingOverwriteRef.current;
    if (pending) {
      runUpload(pending.kbId, pending.formData, true);
      pendingOverwriteRef.current = null;
    }
  };

  /** 打开资源删除确认（列表行的删除入口） */
  const requestDeleteResource = (resource: KnowledgeResourceInfo) => {
    if (!kbId) return;
    setResourceDeleteTarget({ kbId, resourceId: resource.id, name: resource.sourceName });
    setResourceDeleteConfirmOpen(true);
  };

  const confirmDeleteResource = () => {
    if (resourceDeleteTarget) {
      setDeletingResourceId(resourceDeleteTarget.resourceId);
      runDeleteResource(resourceDeleteTarget.kbId, resourceDeleteTarget.resourceId);
    }
  };

  /** 资源的启用开关：成功与失败都重取详情（失败时还要把乐观的开关状态拉回服务端事实） */
  const toggleResourceEnabled = (resource: KnowledgeResourceInfo, enabled: boolean) => {
    if (!kbId) return;
    kbApi
      .toggleResourceEnabled({ kbId, resourceId: resource.id }, { enabled })
      .then(() => runLoadDetail(kbId))
      .catch((error) => {
        console.error("Failed to toggle resource enabled", error);
        toast.error(t("toast.toggleResourceFailed"));
        runLoadDetail(kbId);
      });
  };

  /** 打开重新解析确认：每次打开都把「删除已有分块」复位成未勾选 */
  const requestReparse = (resource: KnowledgeResourceInfo) => {
    setReparseDeleteOld(false);
    setReparseTarget(resource);
    setReparseConfirmOpen(true);
  };

  const confirmReparse = () => {
    if (!reparseTarget || !kbId) return;
    setReparseConfirmOpen(false);
    setReparsingResourceId(reparseTarget.id);
    // 必须解包：`request()` 对 4xx/5xx 返回 `{ success: false }` 而不 throw，直接 then 会把失败
    // 当成功——既弹「已触发」成功提示，又启动一轮注定无结果的状态轮询。
    unwrap(kbApi.reparseResource({ kbId: kbId, resourceId: reparseTarget.id }, { delete: reparseDeleteOld }))
      .then(() => {
        toast.success(t("reparse.started"));
        reparseAndPoll(kbId, reparseTarget.id);
        setReparseDeleteOld(false);
      })
      .catch((err) => {
        // 服务端原文（含 RAGFlow 异常）只进 console，界面按错误码取文案（§9.3）。
        console.error("Reparse failed", err);
        toast.error(getReparseErrorMessage(err, t));
        setReparsingResourceId(null);
        setReparseDeleteOld(false);
      });
  };

  // 当前选中的知识库是否可管理（编辑/删除/上传/重新解析/启用等操作）
  const canManageDetail = selectedDetail ? userId === selectedDetail.userId || isOwner : false;
  /** 覆盖确认弹窗要列出的同名文件（挂起时写入 ref，同一次提交里随 `overwriteConfirmOpen` 一起上屏） */
  const overwriteNames = pendingOverwriteRef.current?.dupNames ?? [];

  return {
    // 详情
    selectedDetail,
    detailLoading,
    detailError,
    tab: detailTab,
    setTab: setDetailTab,
    canManageDetail,
    reload,
    clear,
    applyUpdated,
    handleSelect,
    // 资源
    resources,
    uploading,
    fileInputRef,
    handleFilesSelected,
    overwriteConfirmOpen,
    setOverwriteConfirmOpen,
    overwriteNames,
    confirmOverwriteUpload,
    deletingResourceId,
    resourceDeleteConfirmOpen,
    setResourceDeleteConfirmOpen,
    resourceDeleteTarget,
    requestDeleteResource,
    confirmDeleteResource,
    reparsingResourceId,
    reparseTarget,
    reparseConfirmOpen,
    setReparseConfirmOpen,
    reparseDeleteOld,
    setReparseDeleteOld,
    requestReparse,
    confirmReparse,
    toggleResourceEnabled,
    // 查看类挂载点
    previewResource,
    setPreviewResource,
    selectedChunkResource,
    setSelectedChunkResource,
  };
}
