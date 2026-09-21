import type { ComposerFilePickerRenderProps } from "@fenix/ui-components/chat/composer/ChatComposer";
import type {
  ComposerExternalEvent,
  ComposerExternalSubscribe,
} from "@fenix/ui-components/chat/composer/composer-effects";
import {
  type CompressImage,
  IMAGE_COMPRESSION_OPTIONS,
  type UploadComposerFiles,
  uploadComposerFiles,
} from "@fenix/ui-components/chat/composer/composer-file-processing";
import { PeriTaskDetailSheet } from "@fenix/ui-components/chat/panels/PeriTaskDetailSheet";
import type { ChatNotice, ChatStatsSummary } from "@fenix/ui-components/chat/shell/chat-interface-types";
import type { PeriTaskViewProjection, StructuredMessage, ThreadEntry } from "@fenix/ui-components/chat/types";
import { flushContext } from "@fenix/web-runtime/chat/context-queue";
import { structuredToThreadEntries } from "@fenix/web-runtime/chat/structured-to-thread";
import { dispatchArtifactsPreviewFile } from "@fenix/web-runtime/lib/artifacts-preview-events";
import { ChatStatsDispatcher } from "@fenix/web-runtime/lib/chat-stats";
import imageCompression from "browser-image-compression";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { uploadChatFiles } from "@/src/api/fs";
import { getPeriTaskDetail } from "@/src/api/peri-task-details";
import { FilePickerDialog } from "@/src/components/FilePickerDialog";

/**
 * ChatPanel → `@fenix/ui-components/chat/shell/ACPMain` 的宿主端口装配（CE 阶段 2 任务 1.6 T5c2）。
 *
 * 为什么单独一个模块：ui-components 的 chat 外壳把原先写在 chat 层内部的宿主职责提成注入端口
 * （见 `chat-interface-types.ts` 的端口说明）。这些端口的实现在宿主一侧，与 ChatPanel 的
 * transport/状态机逻辑无关，集中在这里既守住 ChatPanel 的单文件 500 行红线，也让「每个端口
 * 对应哪段源实现」可逐条对照。
 *
 * 逐端口来源（对照 chat-channel `ChatInterface` / `ACPMain` 的线上实现——那两份是该边界的现役代码）：
 *
 * | 端口 | 源实现位置 | 本模块做法 |
 * | --- | --- | --- |
 * | `renderPeriTaskDetail` | `ChatInterface` 直接渲染 agent-runtime 的 `PeriTaskDetailSheet` | 组件已迁 `@fenix/ui-components/chat/panels/PeriTaskDetailSheet`（§1.6 T6a），经注入槽渲染；详情取数由本模块注入 `getPeriTaskDetail`（宿主 API 客户端），包内不依赖资源包；无 `sessionId`（无详情接口）、无 `agentId` 时不给槽（任务行只读，与源 `agentId && detailSessionId` 判定一致） |
 * | `sidebarOpen` / `onSidebarOpenChange` | `ACPMain` 内 `localStorage` 键 `acp-sidebar-open`（缺省展开） | 同一个键、同一处持久化时机（切换时写入），状态由本 hook 受控持有 |
 * | `projectEntries` | `ChatInterface` 直接调用 `@/src/lib/structured-to-thread` | `@fenix/web-runtime/chat/structured-to-thread`（投影函数与宿主副本逐字一致，已核对；纯函数，无双实例状态问题） |
 * | `flushContext` | `ChatInterface` 直接调用 `@/src/lib/context-queue`（**宿主副本**） | `@fenix/web-runtime/chat/context-queue`（**包副本**）——见下方「上下文队列双副本」 |
 * | `onNotice` | `ChatInterface` / `ACPMain` 内的 sonner `toast` | sonner 同级别映射（`toast.info` / `toast.warning` / `toast.error`） |
 * | `onStatsChange` | `ChatInterface` 内 `ChatStatsDispatcher`（1s trailing 节流 + 幂等 + 卸载补发） | 同一个 `ChatStatsDispatcher`，**不传 `emit`**：保持默认的 window `chat:stats` 派发路径，`ChatArea` 的 `useChangedFilesFromStats` 依赖它（改走回调等于把摘要改成组件树内传递，会静默丢掉 ArtifactsPanel 的变更文件）。该处不存在双副本问题：派发靠 window 事件、消费方只读 `detail` 与类型，跨副本等价 |
 * | `onOpenWorkspaceFile` | 工具卡片/用户消息派发 `dispatchArtifactsPreviewFile(envId, path)`，状态面板派发**裸事件**（见下） | 统一走 `dispatchArtifactsPreviewFile`（事件名相同，但状态面板的 detail 由旧实现的「仅 path」补齐为 `{envId, path}`，用户可见行为变更见 review §八） |
 * | `uploadFiles` | `ChatComposer` 内直连 `uploadChatFiles(envId, files)` | 包内 `uploadComposerFiles(files, upload)` 做同样的体积校验与 `{name, path}` 映射，真实上传经本端口注入的宿主 `uploadChatFiles`（包内不持网络依赖） |
 * | `compressImage` | `ChatComposer` 内 `imageCompression(file, IMAGE_COMPRESSION_OPTIONS)` | 同一个库 + 包内导出的同一份参数（参数漂移会让压缩后体积/尺寸与源实现不一致） |
 * | `renderFilePicker` | `ChatComposer` 内按 `envId` 渲染宿主 `FilePickerDialog` | 同一组件；无 `agentId` 时不渲染（源实现同样以 `fileWorkspaceId` 为守卫） |
 * | `subscribeExternal` | `ChatComposer` 的 `file-tree:reference` window 监听（按 `envId` 过滤） | 只桥接该事件：`chat:apply-suggested-prompt` / `chat:quote` 的生产方也在 chat 层内部，已由包内环路闭合（见 ui-components `shell/internal/use-composer-input-bridge.ts`），桥接会重复投递 |
 *
 * 状态面板的裸事件（`onOpenWorkspaceFile` 一行的「详见」）：源实现里三处派发点是**两套写法**——
 * `ToolCallRow` / `MessageBubble` 走 `dispatchArtifactsPreviewFile(envId, path)`，而源实现的状态面板
 * （`packages/agent-runtime/web/components/chat/chat-status-panel.tsx`，已随 T6c2 删除；包内现为
 * `web/chat/panels/chat-status-panel.tsx`）直接
 * `window.dispatchEvent(new CustomEvent("artifacts:preview-file", { detail: { path: file.path } }))`，
 * **不带 envId**；消费方 `getArtifactsPreviewFileDetail` 要求 `detail.envId === envId`，于是事件恒被
 * 判为「其他 environment」并忽略——线上点击状态面板里的变更文件条目从来没有打开过预览（工具卡片、
 * 用户消息里的 `@./path` 点击是正常的）。本端口让两处共用同一个派发器，该点击自此真的打开预览；
 * 这是用户可见行为变更，已登记在 review 文档 §八。
 *
 * 依赖方向：本文件只依赖包出口（`@fenix/ui-components/*`、`@fenix/web-runtime/*`）与 agent-runtime
 * 内部模块；未走 `@/components/chat` 这类宿主别名（该别名已随 T6c2 删除），避免把别名债务再领回一份。
 *
 * 上下文队列双副本：`context-queue` 是**有状态**模块（模块级 `Map` 保存待注入的 system-reminder）。
 * 迁移中途 `apps/web/src/lib/context-queue.ts` 与 `@fenix/web-runtime/chat/context-queue` 同时存在
 * 且不是同一模块实例，于是：
 * - 写入方 `workflow/web/lib/use-workflow-events.ts`、`workflow/web/pages/workflow/WorkflowEditor.tsx`
 *   在任务 1.3 已改指包副本；
 * - 取出方（chat-channel `ChatInterface.flushContext`）此时仍读宿主副本——宿主副本无人写入，
 *   恒返回 `null`，workflow 注入的上下文在 1.3 之后被静默丢弃。
 * 本端口改读包副本（与写入方同实例），因此**修复**了该分裂；宿主副本待 T8 随宿主死副本一并删除。
 * 该行为变更记录在 review 文档 §7.8、用户可见面见 §八。
 */

/** `acp-sidebar-open`：源实现在 `ACPMain`；首次访问无记录时展开。 */
const SIDEBAR_STORAGE_KEY = "acp-sidebar-open";

function readSidebarOpen(): boolean {
  try {
    const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return saved === null ? true : saved === "true";
  } catch {
    // localStorage 不可用（隐私模式/禁用）时按默认展开，与源实现一致
    return true;
  }
}

function writeSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(open));
  } catch {
    // localStorage 不可用时静默失败，与源实现一致
  }
}

/** 注入 `ACPMain` 的宿主端口集合（字段名与 `ACPMainProps` 对应字段一致）。 */
export interface ChatPanelPorts {
  renderPeriTaskDetail: ((task: PeriTaskViewProjection, close: () => void) => ReactNode) | undefined;
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  projectEntries: (structuredMessages: readonly StructuredMessage[]) => ThreadEntry[];
  flushContext: (scope?: string) => string | null;
  uploadFiles: UploadComposerFiles;
  compressImage: CompressImage;
  renderFilePicker: (props: ComposerFilePickerRenderProps) => ReactNode;
  subscribeExternal: ComposerExternalSubscribe;
  onNotice: (notice: ChatNotice) => void;
  onStatsChange: (stats: ChatStatsSummary) => void;
  onOpenWorkspaceFile: (envId: string, path: string) => void;
}

/** 装配 `ACPMain` 的宿主端口。`agentId` 为空时不渲染任何面板，端口的取值只在有环境时被消费。 */
export function useChatPanelPorts({
  agentId,
  sessionId,
}: {
  agentId: string | null;
  sessionId?: string | null;
}): ChatPanelPorts {
  // 会话统计摘要：节流器实例必须跨渲染稳定（每次渲染新建会让节流窗口永不生效）
  const statsDispatcher = useMemo(() => new ChatStatsDispatcher(), []);
  // 卸载时补发待发摘要；不能放进 update effect 的 cleanup——依赖变化也会触发 cleanup，
  // 在那里 flush 会把节流退化为每次变化立即派发（源 `ChatInterface` 同款处理）
  useEffect(() => () => statsDispatcher.flush(), [statsDispatcher]);
  const onStatsChange = useCallback((stats: ChatStatsSummary) => statsDispatcher.update(stats), [statsDispatcher]);

  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  const onSidebarOpenChange = useCallback((open: boolean) => {
    setSidebarOpen(open);
    writeSidebarOpen(open);
  }, []);

  const onNotice = useCallback((notice: ChatNotice) => {
    const notify = notice.level === "error" ? toast.error : notice.level === "warning" ? toast.warning : toast.info;
    notify(notice.message);
  }, []);

  const onOpenWorkspaceFile = useCallback((envId: string, path: string) => {
    dispatchArtifactsPreviewFile(envId, path);
  }, []);

  // 附件上传：无环境时返回空数组（ChatComposer 侧以端口是否存在判定附件入口可用性，故不能省）。
  // 包内 `uploadComposerFiles(files, upload)` 只做体积校验并把结果映射为 `{name, path}`，
  // 真实上传走本端口注入的宿主 `uploadChatFiles`（T6c2 起包内不再持网络依赖）。
  const uploadFiles = useCallback<UploadComposerFiles>(
    (files) =>
      agentId
        ? uploadComposerFiles(files, async (batch) => (await uploadChatFiles(agentId, batch)).files)
        : Promise.resolve([]),
    [agentId],
  );

  const compressImage = useCallback<CompressImage>((file) => imageCompression(file, IMAGE_COMPRESSION_OPTIONS), []);

  const renderFilePicker = useCallback(
    ({ open, onClose, onSelect }: ComposerFilePickerRenderProps): ReactNode =>
      agentId ? <FilePickerDialog open={open} envId={agentId} onClose={onClose} onSelect={onSelect} /> : null,
    [agentId],
  );

  const subscribeExternal = useCallback<ComposerExternalSubscribe>(
    (handler: (event: ComposerExternalEvent) => void) => {
      // 文件树「引用到聊天」：事件是全局 window 通道，环境过滤必须在此完成（包内已无 envId 概念）
      const listener = (event: Event) => {
        const detail = (event as CustomEvent<{ path?: unknown; name?: unknown; envId?: unknown }>).detail;
        if (!agentId || detail?.envId !== agentId) return;
        if (typeof detail.path !== "string" || typeof detail.name !== "string") return;
        handler({ type: "file-reference", file: { name: detail.name, path: detail.path } });
      };
      window.addEventListener("file-tree:reference", listener);
      return () => window.removeEventListener("file-tree:reference", listener);
    },
    [agentId],
  );

  // 详情抽屉：无 `sessionId` 时没有详情接口可查，源实现同样不给入口（任务行只读）
  const renderPeriTaskDetail = useMemo(() => {
    if (!agentId || !sessionId) return;
    return (task: PeriTaskViewProjection, close: () => void) => (
      <PeriTaskDetailSheet
        environmentId={agentId}
        sessionId={sessionId}
        task={task}
        onClose={close}
        loadDetail={getPeriTaskDetail}
      />
    );
  }, [agentId, sessionId]);

  return {
    renderPeriTaskDetail,
    sidebarOpen,
    onSidebarOpenChange,
    projectEntries: structuredToThreadEntries,
    flushContext,
    uploadFiles,
    compressImage,
    renderFilePicker,
    subscribeExternal,
    onNotice,
    onStatsChange,
    onOpenWorkspaceFile,
  };
}
