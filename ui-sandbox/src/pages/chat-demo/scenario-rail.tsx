import {
  AppWindow,
  BotMessageSquare,
  Braces,
  CircleAlert,
  CircleHelp,
  FileStack,
  GitPullRequestArrow,
  KeyRound,
  MessagesSquare,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DEMO_SCENARIOS, type DemoScenarioId } from "./demo-model";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "./demo-ui";
import { useDemoTranslation } from "./use-demo-copy";

const SCENARIO_ICONS = {
  conversation: BotMessageSquare,
  longConversation: MessagesSquare,
  markdown: Braces,
  tools: GitPullRequestArrow,
  permission: KeyRound,
  askUser: CircleHelp,
  subtask: Workflow,
  files: FileStack,
  assets: AppWindow,
  failure: CircleAlert,
  empty: Sparkles,
} as const;

interface ScenarioRailProps {
  activeScenarioId: DemoScenarioId;
  onScenarioChange: (scenarioId: DemoScenarioId) => void;
  onClose: () => void;
}

interface MockSession {
  id: string;
  group: "今天" | "昨天" | "更早";
  title: string;
  unread: boolean;
}

const MOCK_SESSIONS: readonly MockSession[] = [
  { id: "chat-redesign", group: "今天", title: "Chat 面板重构", unread: true },
  { id: "tool-layout", group: "今天", title: "工具调用的紧凑设计", unread: false },
  { id: "mcp-options", group: "昨天", title: "MCP 集成方式讨论", unread: false },
  { id: "release-check", group: "更早", title: "预览环境发布检查", unread: false },
] as const;

/** Provides local-only scene switching for UI review. */
export function ScenarioRail({ activeScenarioId, onScenarioChange, onClose }: ScenarioRailProps) {
  const { t } = useDemoTranslation();
  const [railMode, setRailMode] = useState<"scenarios" | "sessions">("sessions");
  const [sessions, setSessions] = useState<MockSession[]>(() => MOCK_SESSIONS.map((session) => ({ ...session })));
  const [selectedSessionId, setSelectedSessionId] = useState("chat-redesign");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<MockSession | null>(null);
  const nextSessionIdRef = useRef(1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const visibleSessions = sessions.filter((session) =>
    session.title.toLocaleLowerCase().includes(sessionQuery.trim().toLocaleLowerCase()),
  );
  const sessionGroups = ["今天", "昨天", "更早"] as const;

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!editingSessionId) return;
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [editingSessionId]);

  const createSession = () => {
    const session: MockSession = {
      id: `new-session-${nextSessionIdRef.current++}`,
      group: "今天",
      title: "新会话",
      unread: false,
    };
    setRailMode("sessions");
    setSearchOpen(false);
    setSessionQuery("");
    setSessions((current) => [session, ...current]);
    setSelectedSessionId(session.id);
  };

  const startRename = (session: MockSession) => {
    setEditingSessionId(session.id);
    setEditTitle(session.title);
  };

  const finishRename = () => {
    if (!editingSessionId) return;
    const title = editTitle.trim();
    if (title) {
      setSessions((current) =>
        current.map((session) => (session.id === editingSessionId ? { ...session, title } : session)),
      );
    }
    setEditingSessionId(null);
    setEditTitle("");
  };

  const cancelRename = () => {
    setEditingSessionId(null);
    setEditTitle("");
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const remaining = sessions.filter((session) => session.id !== deleteTarget.id);
    setSessions(remaining);
    if (selectedSessionId === deleteTarget.id) {
      setSelectedSessionId(remaining[0]?.id ?? "");
    }
    setDeleteTarget(null);
  };

  return (
    <aside className="chat-demo__rail" aria-label="Chat 会话与设计场景">
      <div className="chat-demo__rail-heading">
        <strong>会话</strong>
        <Button variant="ghost" size="icon-sm" aria-label="关闭会话列表" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="chat-demo__rail-actions">
        <button type="button" className="chat-demo__new-chat" aria-label="新对话" onClick={createSession}>
          <Plus />
          <span>新对话</span>
        </button>
        <button
          type="button"
          className="chat-demo__rail-search"
          aria-label="搜索会话"
          aria-pressed={searchOpen}
          onClick={() => {
            setRailMode("sessions");
            setSearchOpen((open) => !open);
          }}
        >
          <Search />
        </button>
      </div>

      <div className="chat-demo__rail-modes" aria-label="左侧内容" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={railMode === "scenarios"}
          className={railMode === "scenarios" ? "is-active" : undefined}
          onClick={() => setRailMode("scenarios")}
        >
          设计场景
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={railMode === "sessions"}
          className={railMode === "sessions" ? "is-active" : undefined}
          onClick={() => setRailMode("sessions")}
        >
          会话
        </button>
      </div>

      {railMode === "scenarios" ? (
        <nav className="chat-demo__scenario-list">
          {DEMO_SCENARIOS.map((scenario) => {
            const Icon = SCENARIO_ICONS[scenario.id];
            const isActive = scenario.id === activeScenarioId;
            return (
              <button
                key={scenario.id}
                type="button"
                className={`chat-demo__scenario${isActive ? " is-active" : ""}`}
                aria-current={isActive ? "page" : undefined}
                aria-label={undefined}
                onClick={() => onScenarioChange(scenario.id)}
              >
                <span className="chat-demo__scenario-icon">
                  <Icon />
                </span>
                <span className="chat-demo__scenario-copy">
                  <strong>{t(`scenarios.${scenario.id}.label`)}</strong>
                  <small>{t(`scenarios.${scenario.id}.description`)}</small>
                </span>
              </button>
            );
          })}
        </nav>
      ) : (
        <div className="chat-demo__session-browser">
          {searchOpen && (
            <label className="chat-demo__session-search">
              <Search />
              <input
                ref={searchInputRef}
                value={sessionQuery}
                placeholder="搜索会话"
                onChange={(event) => setSessionQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSessionQuery("");
                    setSearchOpen(false);
                  }
                }}
              />
            </label>
          )}
          <div className="chat-demo__session-list">
            {visibleSessions.length === 0 && (
              <div className="chat-demo__session-empty">
                <Search />
                <span>没有匹配的会话</span>
              </div>
            )}
            {sessionGroups.map((group) => {
              const sessions = visibleSessions.filter((session) => session.group === group);
              if (sessions.length === 0) return null;
              return (
                <section key={group} className="chat-demo__session-group" aria-label={group}>
                  <h2>{group}</h2>
                  {sessions.map((session) => {
                    const isSelected = selectedSessionId === session.id;
                    const isEditing = editingSessionId === session.id;
                    return (
                      <div key={session.id} className={`chat-demo__session-row${isSelected ? " is-active" : ""}`}>
                        {isEditing ? (
                          <div className="chat-demo__session-editor">
                            <input
                              ref={editInputRef}
                              value={editTitle}
                              aria-label="编辑会话名称"
                              onChange={(event) => setEditTitle(event.target.value)}
                              onBlur={finishRename}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") finishRename();
                                if (event.key === "Escape") cancelRename();
                              }}
                            />
                            <button
                              type="button"
                              aria-label="取消重命名"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={cancelRename}
                            >
                              <X />
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="chat-demo__session"
                              aria-current={isSelected ? "page" : undefined}
                              aria-label={undefined}
                              title={session.title}
                              onClick={() => {
                                setSelectedSessionId(session.id);
                                setSessions((current) =>
                                  current.map((item) => (item.id === session.id ? { ...item, unread: false } : item)),
                                );
                              }}
                            >
                              <strong>{session.title}</strong>
                            </button>
                            <div className="chat-demo__session-actions">
                              {session.unread && (
                                <>
                                  <span className="chat-demo__session-unread" aria-hidden="true" />
                                  <span className="sr-only">未读</span>
                                </>
                              )}
                              <button
                                type="button"
                                aria-label={`重命名 ${session.title}`}
                                title="重命名"
                                onClick={() => startRename(session)}
                              >
                                <Pencil />
                              </button>
                              <button
                                type="button"
                                aria-label={`删除 ${session.title}`}
                                title="删除"
                                onClick={() => setDeleteTarget(session)}
                              >
                                <Trash2 />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
        </div>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>删除会话？</AlertDialogTitle>
            <AlertDialogDescription>“{deleteTarget?.title ?? ""}”将从本地 mock 会话列表中移除。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={confirmDelete}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
