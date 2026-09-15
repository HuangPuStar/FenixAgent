import type {
  AvailableCommand,
  ChatStateSnapshot,
  ContentBlock,
  PeriTaskViewProjection,
  SessionMode,
  SessionStateSnapshot,
} from "@fenix/chat-channel";

export interface ChatInterfaceProps {
  agentId?: string;
  readonly?: boolean;
  hideContextPanel?: boolean;
  rcsSessionId?: string;
  detailSessionId?: string;
  onSessionCreated?: (sessionId: string) => void;
  scenePrompt?: string;
  onPromptComplete?: () => void;
  contextKey?: string;
  sessionState?: SessionStateSnapshot | null;
  chatState?: ChatStateSnapshot;
  onSendPrompt: (contentBlocks: ContentBlock[]) => Promise<void>;
  onCancel: () => void;
  onCreateSession: () => Promise<void>;
  onRespondPermission: (requestId: string, optionId: string | null) => void;
  onRespondQuestion: (questionId: string, answers: Array<string | string[]>) => void;
  availableCommands: AvailableCommand[];
  availableModes: SessionMode[];
  currentModeId: string | null;
  onSetMode: (modeId: string) => void;
  supportsModeSelection: boolean;
  supportsImages: boolean;
  modelName: string | undefined;
  tokenUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; contextWindow?: number } | null;
  periTasks?: readonly PeriTaskViewProjection[];
  periTasksLoaded?: boolean;
  connectionState?: string;
}

export interface ChatInterfaceHandle {
  newSession: () => void;
  /** 当前是否正在等待 agent 响应。 */
  isLoading: boolean;
}
