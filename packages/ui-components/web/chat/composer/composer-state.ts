import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AvailableCommand, FileAttachment, UserMessageImage } from "../types";
import type { McpOption } from "./CommandMenu";
import type { ComposerQuote } from "./composer-assets";

/**
 * 输入岛状态（半受控）。
 *
 * 来源：从 `packages/agent-runtime/web/components/chat/ChatComposer.tsx` 的 state / ref /
 * 派生值与面板状态迁移中切出——拆分原因是源文件 597 行超过 500 行红线。行为保持源实现：
 * 未传受控 prop 时全部自持；传入受控 prop 后以宿主为准并回调（半受控）。
 * 纯化改动点：
 * - 文本 / 附件 / 引用 / 命令面板额外提供受控 prop 与变更回调（源实现全部为组件内部状态），
 *   宿主可据此在会话切换或草稿持久化时接管输入状态。
 * - 源 `quotesRef` 的「同步拿到最新引用」写法由半受控状态的内部 ref 统一承担，
 *   外部行为（含 `chat:quote` 事件里的配额判断）不变。
 * - `contextScope` 变化即清空引用（源实现的 keep-alive 会话隔离行为）保留。
 */

/**
 * 半受控状态原语：`controlled === undefined` 时用内部 state，否则以受控值为准。
 * 内部 ref 始终保存最后一次已知值，保证函数式更新（`setValue(current => next)`）看到最新值。
 */
export function useSemiControlledState<T>(
  controlled: T | undefined,
  onChange: ((value: T) => void) | undefined,
  initial: T,
): [T, (next: T | ((current: T) => T)) => void] {
  const [internal, setInternal] = useState<T>(initial);
  const value = controlled === undefined ? internal : controlled;
  const valueRef = useRef(value);
  valueRef.current = value;

  const setValue = useCallback(
    (next: T | ((current: T) => T)) => {
      const resolved = typeof next === "function" ? (next as (current: T) => T)(valueRef.current) : next;
      valueRef.current = resolved;
      if (controlled === undefined) setInternal(resolved);
      onChange?.(resolved);
    },
    [controlled, onChange],
  );

  return [value, setValue];
}

export interface ComposerStateOptions {
  /** Agent 提供的可用 slash 命令（用于派生正文中已选的命令名）。 */
  commands?: readonly AvailableCommand[];
  /** 确定性会话标识；变化时清空引用，避免 keep-alive Chat 之间串引用。 */
  contextScope?: string;
  /** 受控草稿文本。 */
  draft?: string;
  /** 非受控草稿初始值（受控时忽略）。 */
  defaultDraft?: string;
  onDraftChange?: (text: string) => void;
  /** 受控待发送附件列表。 */
  attachments?: FileAttachment[];
  onAttachmentsChange?: (attachments: FileAttachment[]) => void;
  /** 受控待发送引用列表。 */
  quotes?: ComposerQuote[];
  onQuotesChange?: (quotes: ComposerQuote[]) => void;
  /** 受控命令/能力面板开关。 */
  commandPanelOpen?: boolean;
  onCommandPanelOpenChange?: (open: boolean) => void;
}

/** `useComposerState` 的返回值：输入岛的全部输入状态与状态迁移。 */
export interface ComposerState {
  text: string;
  setText: (next: string | ((current: string) => string)) => void;
  images: UserMessageImage[];
  addImages: (images: UserMessageImage[]) => void;
  removeImage: (index: number) => void;
  attachments: FileAttachment[];
  /** 追加附件（按 path 去重，源实现在四处重复的同一段逻辑）。 */
  addAttachments: (files: FileAttachment[]) => void;
  removeAttachment: (path: string) => void;
  quotes: ComposerQuote[];
  updateQuotes: (next: ComposerQuote[] | ((current: ComposerQuote[]) => ComposerQuote[])) => void;
  selectedMcpIds: ReadonlySet<string>;
  toggleMcp: (mcp: McpOption) => void;
  /** 正文中以 `/name` 形式出现且属于 Agent 公布命令的名字集合（源派生逻辑逐字保留）。 */
  selectedCommandNames: ReadonlySet<string>;
  commandPanelOpen: boolean;
  /** 工具栏模式（带搜索输入）与 slash 模式（焦点留在 textarea）的区别。 */
  commandPanelSearch: boolean;
  commandFilter: string;
  /** slash 输入阶段：以正文中的命令名作为过滤词打开面板。 */
  filterCommandPanel: (filter: string) => void;
  /** 工具栏「技能」按钮：打开带搜索输入的面板。 */
  openCommandPanelSearch: () => void;
  /** 仅清空过滤词（工具栏模式选中命令后源实现只清过滤词，面板保持打开）。 */
  resetCommandFilter: () => void;
  closeCommandPanel: () => void;
  /** 提交后清空本轮输入（正文 / 图片 / 附件 / 引用 / MCP 选择）。 */
  resetInput: () => void;
}

/** 输入岛的半受控状态容器（受控 prop 缺省时行为与源实现的组件内部状态一致）。 */
export function useComposerState({
  commands,
  contextScope,
  draft,
  defaultDraft,
  onDraftChange,
  attachments: controlledAttachments,
  onAttachmentsChange,
  quotes: controlledQuotes,
  onQuotesChange,
  commandPanelOpen: controlledCommandPanelOpen,
  onCommandPanelOpenChange,
}: ComposerStateOptions): ComposerState {
  const [text, setText] = useSemiControlledState(draft, onDraftChange, defaultDraft ?? "");
  const [images, setImages] = useState<UserMessageImage[]>([]);
  const [attachments, setAttachments] = useSemiControlledState<FileAttachment[]>(
    controlledAttachments,
    onAttachmentsChange,
    [],
  );
  const [quotes, setQuotes] = useSemiControlledState<ComposerQuote[]>(controlledQuotes, onQuotesChange, []);
  const [selectedMcpIds, setSelectedMcpIds] = useState<Set<string>>(new Set());
  const [commandPanelOpen, setCommandPanelOpen] = useSemiControlledState(
    controlledCommandPanelOpen,
    onCommandPanelOpenChange,
    false,
  );
  const [commandPanelSearch, setCommandPanelSearch] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");

  const selectedCommandNames = useMemo(() => {
    const availableNames = new Set((commands ?? []).map((command) => command.name));
    const names = text.match(/(?:^|\s)\/([^\s]+)/g)?.map((token) => token.trim().slice(1)) ?? [];
    return new Set(names.filter((name) => availableNames.has(name)));
  }, [commands, text]);

  // 会话标识变化时清空引用（源实现逐字保留：只清引用，草稿与附件不动）
  const previousContextScopeRef = useRef(contextScope);
  useEffect(() => {
    if (previousContextScopeRef.current === contextScope) return;
    previousContextScopeRef.current = contextScope;
    setQuotes([]);
  }, [contextScope, setQuotes]);

  const updateQuotes = useCallback<ComposerState["updateQuotes"]>(
    (next) => {
      setQuotes(next);
    },
    [setQuotes],
  );

  const addImages = useCallback((next: UserMessageImage[]) => {
    setImages((prev) => [...prev, ...next]);
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addAttachments = useCallback<ComposerState["addAttachments"]>(
    (files) => {
      setAttachments((prev) => {
        const existing = new Set(prev.map((file) => file.path));
        const unique = files.filter((file) => !existing.has(file.path));
        return unique.length === 0 ? prev : [...prev, ...unique];
      });
    },
    [setAttachments],
  );

  const removeAttachment = useCallback(
    (path: string) => {
      setAttachments((current) => current.filter((file) => file.path !== path));
    },
    [setAttachments],
  );

  const toggleMcp = useCallback((mcp: McpOption) => {
    setSelectedMcpIds((current) => {
      const next = new Set(current);
      if (next.has(mcp.id)) next.delete(mcp.id);
      else next.add(mcp.id);
      return next;
    });
  }, []);

  const closeCommandPanel = useCallback(() => {
    setCommandFilter("");
    setCommandPanelSearch(false);
    setCommandPanelOpen(false);
  }, [setCommandPanelOpen]);

  const filterCommandPanel = useCallback(
    (filter: string) => {
      setCommandFilter(filter);
      setCommandPanelSearch(false);
      setCommandPanelOpen(true);
    },
    [setCommandPanelOpen],
  );

  const openCommandPanelSearch = useCallback(() => {
    setCommandFilter("");
    setCommandPanelSearch(true);
    setCommandPanelOpen(true);
  }, [setCommandPanelOpen]);

  const resetCommandFilter = useCallback(() => {
    setCommandFilter("");
  }, []);

  const resetInput = useCallback(() => {
    setText("");
    setImages([]);
    setAttachments([]);
    setQuotes([]);
    setSelectedMcpIds(new Set());
  }, [setAttachments, setQuotes, setText]);

  return {
    text,
    setText,
    images,
    addImages,
    removeImage,
    attachments,
    addAttachments,
    removeAttachment,
    quotes,
    updateQuotes,
    selectedMcpIds,
    toggleMcp,
    selectedCommandNames,
    commandPanelOpen,
    commandPanelSearch,
    commandFilter,
    filterCommandPanel,
    openCommandPanelSearch,
    resetCommandFilter,
    closeCommandPanel,
    resetInput,
  };
}
