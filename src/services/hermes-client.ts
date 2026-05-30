import { log, error as logError } from "../logger";
import { eventService } from "../services/event-service";
import { findRunningInstanceByEnvironment, sendToAgentWs, sendToInstanceRelay } from "../transport/relay";
import { findBindingForMessage } from "./channel-binding";

// --- Types ---

export interface HermesStatus {
  connected: boolean;
  url: string;
  platforms: string[];
  reconnecting: boolean;
  lastConnectedAt: number | null;
}

interface HermesInboundMessage {
  type: "message";
  data: {
    text: string;
    message_type: string;
    source: {
      platform: string;
      chat_id: string;
      user_id: string;
      user_name: string;
      chat_type: string;
    };
    message_id: string;
    timestamp: string;
  };
}

// biome-ignore lint/correctness/noUnusedVariables: outbound message type kept for reference
interface HermesOutboundSend {
  type: "send";
  platform: string;
  chat_id: string;
  content: string;
  reply_to?: string;
}

// --- HermesClient ---

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export class HermesClient {
  private ws: WebSocket | null = null;
  private status: HermesStatus = {
    connected: false,
    url: "",
    platforms: [],
    reconnecting: false,
    lastConnectedAt: null,
  };
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private statusListeners = new Set<(status: HermesStatus) => void>();
  private stopped = false;
  private reconnectAttempts = 0;
  private bindingUnsubs = new Map<string, () => void>();
  private platforms: string[];

  // Default platforms to subscribe on connect (covers common Hermes platforms).
  // Hermes replies with "disconnected" for platforms it doesn't have, so it's
  // safe to always subscribe to all of them.
  private static readonly KNOWN_PLATFORMS = ["feishu", "telegram", "discord", "slack", "wecom", "weixin", "dingtalk"];

  constructor(url: string) {
    this.status.url = url;
    const envPlatforms = process.env.HERMES_PLATFORMS;
    if (envPlatforms) {
      this.platforms = envPlatforms
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    } else {
      this.platforms = HermesClient.KNOWN_PLATFORMS;
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({ type: "unsubscribe" }));
      } catch {}
      this.ws.close(1000, "shutdown");
    }
    // Clean up all outbound routing subscriptions
    for (const [_bindingId, unsub] of this.bindingUnsubs) {
      try {
        unsub();
      } catch {}
    }
    this.bindingUnsubs.clear();
    this.status.connected = false;
    this.status.reconnecting = false;
    this.notifyStatusChange();
    log("[Hermes] Client stopped");
  }

  getStatus(): HermesStatus {
    return { ...this.status };
  }

  send(platform: string, chatId: string, text: string, replyTo?: string): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const id = `rcs_${crypto.randomUUID().replace(/-/g, "")}`;
    const msg: Record<string, unknown> = { type: "send", id, platform, chat_id: chatId, content: text };
    if (replyTo) msg.reply_to = replyTo;
    this.ws.send(JSON.stringify(msg));
  }

  onStatusChange(cb: (status: HermesStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  // --- Private methods ---

  private subscribePlatforms(platforms: string[]): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (platforms.length === 0) return;
    try {
      this.ws.send(JSON.stringify({ type: "subscribe", platforms }));
      log(`[Hermes] Subscribed to platforms: ${platforms.join(", ")}`);
    } catch {}
  }

  private connect(): void {
    this.ws = new WebSocket(this.status.url);

    this.ws.onopen = () => {
      this.status.connected = true;
      this.status.reconnecting = false;
      this.status.lastConnectedAt = Date.now();
      this.reconnectAttempts = 0;
      this.notifyStatusChange();

      // Subscribe to platforms
      this.subscribePlatforms(this.platforms);

      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      for (const line of text.split("\n").filter((l) => l.trim())) {
        try {
          const msg = JSON.parse(line);
          this.handleMessage(msg);
        } catch {}
      }
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.status.connected = false;
      if (!this.stopped) {
        this.scheduleReconnect();
      }
      this.notifyStatusChange();
    };

    this.ws.onerror = () => {
      logError("[Hermes] WebSocket error");
    };
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === "message") {
      this.handleInboundMessage(msg as unknown as HermesInboundMessage);
    } else if (msg.type === "pong") {
      if (this.pongTimeout) {
        clearTimeout(this.pongTimeout);
        this.pongTimeout = null;
      }
    } else if (msg.type === "platform_status") {
      const event = msg as { platform?: string; state?: string };
      const platform = event.platform;
      const state = event.state;
      if (platform && state === "connected") {
        // Auto-subscribe to newly connected platforms
        if (!this.status.platforms.includes(platform)) {
          this.status.platforms.push(platform);
          this.subscribePlatforms([platform]);
        }
        this.notifyStatusChange();
      } else if (platform && state === "disconnected") {
        this.status.platforms = this.status.platforms.filter((p) => p !== platform);
        this.notifyStatusChange();
      }
    } else if (msg.type === "error") {
      logError("[Hermes] Error from gateway:", msg);
    } else if (msg.type === "result") {
      const result = msg as { success?: boolean; error?: string; id?: string };
      if (!result.success) {
        logError(`[Hermes] Send failed: ${result.error || "unknown"} (id=${result.id})`);
      }
    }
  }

  private async handleInboundMessage(msg: HermesInboundMessage): Promise<void> {
    const platform = msg.data.source.platform;
    const chatId = msg.data.source.chat_id;

    log(`[Hermes] Inbound message: platform=${platform} chatId=${chatId} text="${msg.data.text?.slice(0, 50)}"`);

    const match = await findBindingForMessage(platform, chatId);
    if (!match) {
      log(`[Hermes] No binding for ${platform}/${chatId}`);
      return;
    }

    log(`[Hermes] Found binding: agentId=${match.binding.agentId} matchType=${match.matchType}`);
    await this.routeToAgent(match.binding.agentId, msg);
  }

  private async routeToAgent(agentId: string, hermesMsg: HermesInboundMessage): Promise<void> {
    const acpMsg = {
      type: "prompt",
      payload: {
        content: [{ type: "text" as const, text: hermesMsg.data.text }],
        // Attach hermes metadata for context (won't break acp-link)
        _hermes: {
          platform: hermesMsg.data.source.platform,
          chat_id: hermesMsg.data.source.chat_id,
          user_id: hermesMsg.data.source.user_id,
          user_name: hermesMsg.data.source.user_name,
          message_id: hermesMsg.data.message_id,
        },
      },
    };

    const replyTo = hermesMsg.data.message_id;

    // Always set up outbound routing so replies are forwarded when agent comes online
    this.ensureOutboundRouting(hermesMsg.data.source.platform, hermesMsg.data.source.chat_id, agentId, replyTo);

    // Try spawned instance first
    const instance = await findRunningInstanceByEnvironment(agentId);
    log(`[Hermes] findRunningInstanceByEnvironment(${agentId}) => ${instance ? instance.id : "null"}`);
    if (instance) {
      const sent = sendToInstanceRelay(instance.id, JSON.stringify(acpMsg));
      if (sent) {
        log(`[Hermes] Routed message to instance ${instance.id} for agent ${agentId}`);
        return;
      }
    }

    // Fallback: direct ACP connection
    const sent = sendToAgentWs(agentId, acpMsg);
    log(`[Hermes] sendToAgentWs(${agentId}) => ${sent}`);
    if (sent) {
      log(`[Hermes] Routed message to agent ${agentId} via ACP WS`);
      return;
    }

    logError(`[Hermes] Agent ${agentId} is offline, message will be delivered when agent connects`);
  }

  private ensureOutboundRouting(platform: string, chatId: string, agentId: string, replyTo?: string): void {
    const subKey = `${platform}:${chatId}:${agentId}`;
    if (this.bindingUnsubs.has(subKey)) return;

    let accumulated = "";

    const bus = eventService.getAcpBus(agentId);
    const unsub = bus.subscribe((event) => {
      if (event.direction !== "inbound") return;

      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload) return;

      // ACP session_update with agent_message_chunk: accumulate text
      if (event.type === "session_update") {
        const inner = payload.payload as Record<string, unknown> | undefined;
        if (!inner) return;
        const update = inner.update as Record<string, unknown> | undefined;
        if (!update || update.sessionUpdate !== "agent_message_chunk") return;
        const content = update.content as Record<string, unknown> | undefined;
        if (!content || content.type !== "text" || typeof content.text !== "string") return;
        accumulated += content.text;
        return;
      }

      // prompt_complete: flush accumulated text and reset for next turn
      if (event.type === "prompt_complete") {
        if (accumulated) {
          log(`[Hermes] Sending reply to ${platform} chat_id=${chatId}, text length=${accumulated.length}`);
          this.send(platform, chatId, accumulated, replyTo);
        }
        accumulated = "";
        return;
      }
    });

    this.bindingUnsubs.set(subKey, unsub);
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        try {
          this.ws.send(JSON.stringify({ type: "ping" }));
        } catch {}
      }
      // Set pong timeout
      this.pongTimeout = setTimeout(() => {
        logError("[Hermes] Pong timeout, closing connection");
        if (this.ws) {
          this.ws.close();
        }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(2000 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempts++;
    this.status.reconnecting = true;
    this.notifyStatusChange();
    log(`[Hermes] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private notifyStatusChange(): void {
    const snapshot = this.getStatus();
    for (const cb of this.statusListeners) {
      try {
        cb(snapshot);
      } catch {}
    }
  }
}

// --- Singleton ---

let hermesClientInstance: HermesClient | null = null;

export function getHermesClient(): HermesClient | null {
  return hermesClientInstance;
}

export function initHermesClient(url: string): HermesClient {
  if (hermesClientInstance) {
    hermesClientInstance.stop();
  }
  hermesClientInstance = new HermesClient(url);
  hermesClientInstance.start().catch((err) => {
    logError("[Hermes] Client start failed:", err);
  });
  return hermesClientInstance;
}
