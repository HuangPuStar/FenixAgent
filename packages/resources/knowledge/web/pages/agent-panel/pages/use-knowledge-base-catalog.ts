// web/pages/agent-panel/pages/use-knowledge-base-catalog.ts
// 知识库**列表与建档**域的状态归属与编排（§3.5 三层拆分的第二层）：列表 / 表单元数据取数、
// 创建 / 更新 / 删除，以及 RAGFlow 未关联知识库的导入（含两段式改名）。
//
// 从 `AgentKnowledgeBasesPage.tsx` 拆出（§4.7）。域内不读详情域的任何状态：删除当前选中的知识库
// 会牵动详情域与路由参数，这里只经 `onKnowledgeBaseDeleted` 通知调用方；编辑弹窗要预填的名称 / 描述
// 由调用方在打开时作为入参递进来（详情域的值不在这里反向读取）。

import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { kbApi } from "../../../api/knowledge-bases";
import type {
  KnowledgeBaseCreateBody,
  KnowledgeBaseDetail,
  KnowledgeBaseInfo,
  KnowledgeFormOptions,
  KnowledgeParseMethod,
  UnassociatedKnowledgeBase,
} from "../../../types/knowledge";

interface UseKnowledgeBaseCatalogOptions {
  /** 当前选中的知识库 id（路由 `?kbId=`）：只用来判断「删掉的正是当前选中这一个」 */
  kbId: string | null;
  /** 删除知识库成功且删的是当前选中项时的通知（调用方清空路由参数与详情域） */
  onKnowledgeBaseDeleted: () => void;
  /** 更新成功后的通知：把后端返回的最新数据同步进详情头部（详情状态由调用方转交） */
  onKnowledgeBaseUpdated: (id: string, updated: KnowledgeBaseInfo) => void;
}

export function useKnowledgeBaseCatalog({
  kbId,
  onKnowledgeBaseDeleted,
  onKnowledgeBaseUpdated,
}: UseKnowledgeBaseCatalogOptions) {
  const { t } = useTranslation(NS.KNOWLEDGE);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseInfo | null>(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<KnowledgeBaseInfo | null>(null);
  // 表单字段
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formEmbeddingModel, setFormEmbeddingModel] = useState("");
  const [formParseMethod, setFormParseMethod] = useState<KnowledgeParseMethod>("builtin");
  const [formChunkMethod, setFormChunkMethod] = useState("");
  const [formPipeline, setFormPipeline] = useState("");
  // 导入对话框
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [unassociatedList, setUnassociatedList] = useState<UnassociatedKnowledgeBase[]>([]);
  const [importingRemoteId, setImportingRemoteId] = useState<string | null>(null);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<UnassociatedKnowledgeBase | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // 列表查询
  const {
    data: listData,
    loading,
    error: listError,
    refresh,
  } = useRequest(() => unwrap(kbApi.list()), {
    onError: (err) => {
      console.error("Failed to load knowledge bases", err);
      // 列表失败只上屏字典文案（§9.3）：`err.message` 是 `unwrap` 抛出的 `ApiError.message`，即后端
      // 错误信封原文（服务端措辞、表名、路径都可能出现），只进上面的日志。
      toast.error(t("loadError"));
    },
  });

  const items: KnowledgeBaseInfo[] = Array.isArray(listData) ? listData : [];

  const {
    data: formOptions,
    error: formOptionsError,
    refresh: refreshFormOptions,
  } = useRequest(() => unwrap(kbApi.getFormOptions()), {
    refreshDeps: [],
    onError: (err) => {
      // 选项拉取失败不再静默降级：创建弹窗的解析配置区会整区接管为可重试的显式错误态
      // （见下面 formOptionsFailed 分支）。这里只保留诊断上下文。
      console.error("Failed to load knowledge form options", err);
    },
  });
  const options: KnowledgeFormOptions | null = formOptions ?? null;
  // 判据：`error && 无选项` 才整区接管；已有选项后的刷新失败保留旧选项（ahooks 在失败时保留
  // 上一次成功的数据），此时表单照常可用，不弹错误区。
  const formOptionsFailed = formOptionsError != null && options == null;

  // 创建知识库
  const { run: runCreate, loading: createSaving } = useRequest(
    (payload: KnowledgeBaseCreateBody) => unwrap(kbApi.create(payload)),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("toast.created"));
        setDialogOpen(false);
        refresh();
      },
      onError: (err) => {
        console.error("Create failed", err);
        toast.error(t("toast.saveFailed"));
      },
    },
  );

  // 更新知识库
  const { run: runUpdate, loading: updateSaving } = useRequest(
    (id: string, payload: { name: string; description?: string }) => unwrap(kbApi.update({ id }, payload)),
    {
      manual: true,
      onSuccess: (updated, [id]) => {
        toast.success(t("toast.updated"));
        setDialogOpen(false);
        // 用后端返回的最新数据同步详情头部，避免改名/改描述后需刷新才生效（详情域由调用方转交）
        onKnowledgeBaseUpdated(id, updated);
        refresh();
      },
      onError: (err) => {
        console.error("Update failed", err);
        toast.error(t("toast.saveFailed"));
      },
    },
  );

  const saving = createSaving || updateSaving;

  // 删除知识库
  const { run: runDelete } = useRequest((id: string) => unwrap(kbApi.del({ id })), {
    manual: true,
    onSuccess: (_data, [id]) => {
      toast.success(t("toast.deleted"));
      setConfirmOpen(false);
      // 删掉的是当前选中那一个：路由参数与详情域由调用方负责（域内不反向读取详情状态）
      if (kbId === id) onKnowledgeBaseDeleted();
      setDeleteTarget(null);
      refresh();
    },
    onError: (err) => {
      console.error("Delete failed", err);
      toast.error(t("toast.deleteFailed"));
    },
  });

  // 打开创建弹窗：只把表单字段复位到新草稿，是否具备创建条件（向量模型等）由提交时的校验判定
  const openCreateDialog = async () => {
    setEditingItem(null);
    setFormName("");
    setFormDescription("");
    setFormEmbeddingModel("");
    setFormParseMethod("builtin");
    setFormChunkMethod("");
    setFormPipeline("");
    setDialogOpen(true);
  };

  // 打开编辑弹窗：仅 name/description 可改，配置字段不展示
  const openEditDialog = (detail: KnowledgeBaseDetail | null) => {
    setEditingItem(items.find((i) => i.id === kbId) ?? null);
    setFormName(detail?.name ?? "");
    setFormDescription(detail?.description ?? "");
    setDialogOpen(true);
  };

  /**
   * 提交创建 / 编辑表单：编辑只发名称与描述，创建还要把解析配置一起发出。
   * 前端的两处校验（名称非空、嵌入模型的 `model@provider` 格式）在发请求前拦截。
   */
  const submitForm = () => {
    if (!formName.trim()) {
      toast.error(t("validation.nameRequired"));
      return;
    }
    const name = formName.trim();
    const description = formDescription.trim() || undefined;
    if (editingItem) {
      // 编辑模式：仅 name/description 可改，配置字段创建时已锁定
      runUpdate(editingItem.id, { name, description });
      return;
    }
    // 创建模式：透传嵌入模型 / 解析方法 / 分块方法
    const embeddingModel = formEmbeddingModel || null;
    if (!embeddingModel) {
      toast.error(t("validation.embeddingModelRequired"));
      return;
    }
    // 前端校验：嵌入模型必须含 @（RagFlow v0.26 要求 model@provider 格式）
    if (!embeddingModel.includes("@")) {
      toast.error(t("validation.embeddingModelFormat"));
      return;
    }
    const slug = name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "");
    runCreate({
      name,
      slug,
      description,
      embeddingModel,
      parseMethod: formParseMethod,
      pipelineId: formParseMethod === "pipeline" ? formPipeline || null : null,
      chunkMethod: formParseMethod === "builtin" ? formChunkMethod || null : null,
    });
  };

  /** 打开删除确认（列表行与详情头部两处入口共用） */
  const requestDelete = (item: KnowledgeBaseInfo | null) => {
    setDeleteTarget(item);
    setConfirmOpen(true);
  };

  const confirmDelete = () => {
    if (deleteTarget) runDelete(deleteTarget.id);
  };

  // 打开导入对话框
  const openImportDialog = async () => {
    setImportDialogOpen(true);
    setImportLoading(true);
    setUnassociatedList([]);
    try {
      const list = await unwrap(kbApi.listUnassociated());
      setUnassociatedList(list);
    } catch (err) {
      // 此前只上屏、不落日志：原始 error 对象必须先留在诊断通道里（§5.8 的判据只约束「必须有用户
      // 可见反馈」，不豁免日志）。文案同样只取字典（§9.3）。
      console.error("Failed to list unassociated knowledge bases", err);
      toast.error(t("toast.listUnassociatedFailed"));
    } finally {
      setImportLoading(false);
    }
  };

  // 导入单个知识库
  const handleImport = async (remoteId: string, name: string) => {
    setImportingRemoteId(remoteId);
    try {
      await unwrap(kbApi.import(remoteId, name));
      toast.success(t("toast.imported", { name }));
      setUnassociatedList((prev) => prev.filter((ds) => ds.id !== remoteId));
      setRenameDialogOpen(false);
      setRenameTarget(null);
      refresh();
    } catch (err) {
      console.error("Failed to import knowledge base", err);
      toast.error(t("toast.importFailed"));
    } finally {
      setImportingRemoteId(null);
    }
  };

  /** 点「导入」先进入第二段改名确认：目标与输入值都按远端名称预填 */
  const requestImport = (item: UnassociatedKnowledgeBase) => {
    setRenameTarget(item);
    setRenameValue(item.name);
    setRenameDialogOpen(true);
  };

  /** 取消改名：关弹窗并清掉目标（`onOpenChange` 只关弹窗，与拆分前的口径一致） */
  const cancelRename = () => {
    setRenameDialogOpen(false);
    setRenameTarget(null);
  };

  /** 确认导入：名称非空才发请求（回车与按钮两条入口共用） */
  const confirmRename = () => {
    if (renameTarget && renameValue.trim()) {
      handleImport(renameTarget.id, renameValue.trim());
    }
  };

  /** 当前选中的列表行（详情头部的编辑 / 删除入口要它的 id 与 name） */
  const selectedItem = kbId ? (items.find((i) => i.id === kbId) ?? null) : null;

  return {
    // 列表
    items,
    loading,
    listError,
    refresh,
    selectedItem,
    // 表单元数据
    options,
    formOptionsError,
    formOptionsFailed,
    refreshFormOptions,
    modelDialogOpen,
    setModelDialogOpen,
    // 创建 / 编辑表单
    formOpen: dialogOpen,
    setFormOpen: setDialogOpen,
    editingItem,
    saving,
    formName,
    setFormName,
    formDescription,
    setFormDescription,
    formEmbeddingModel,
    setFormEmbeddingModel,
    formParseMethod,
    setFormParseMethod,
    formChunkMethod,
    setFormChunkMethod,
    formPipeline,
    setFormPipeline,
    openCreateDialog,
    openEditDialog,
    submitForm,
    // 删除
    confirmOpen,
    setConfirmOpen,
    deleteTarget,
    requestDelete,
    confirmDelete,
    // 导入
    importDialogOpen,
    setImportDialogOpen,
    importLoading,
    unassociatedList,
    importingRemoteId,
    openImportDialog,
    handleImport,
    renameDialogOpen,
    setRenameDialogOpen,
    renameTarget,
    renameValue,
    setRenameValue,
    requestImport,
    cancelRename,
    confirmRename,
  };
}
