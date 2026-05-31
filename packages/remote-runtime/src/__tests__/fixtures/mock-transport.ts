import type { RemoteTransport, TransportMessage } from "../../remote-transport";

export interface MockTransport extends RemoteTransport {
  simulateResponse(requestId: string, response: Partial<TransportMessage>): void;
  simulateSessionMessage(instanceId: string, sessionId: string, message: TransportMessage): void;
  sentMessages: TransportMessage[];
}

export function createMockTransport(): MockTransport {
  const sentMessages: TransportMessage[] = [];
  const pendingResolvers = new Map<
    string,
    {
      resolve: (msg: TransportMessage) => void;
    }
  >();
  const sessionListeners = new Set<(instanceId: string, sessionId: string, message: TransportMessage) => void>();

  return {
    sentMessages,

    async sendAndWait(message, _options) {
      const requestId = message.request_id ?? "auto_req";
      sentMessages.push({ ...message, request_id: requestId });

      return new Promise<TransportMessage>((resolve) => {
        pendingResolvers.set(requestId, { resolve });
      });
    },

    onSessionMessage(listener) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },

    send(message) {
      sentMessages.push(message);
    },

    simulateResponse(requestId, response) {
      const pending = pendingResolvers.get(requestId);
      if (pending) {
        pendingResolvers.delete(requestId);
        pending.resolve({ request_id: requestId, ...response });
      }
    },

    simulateSessionMessage(instanceId, sessionId, message) {
      for (const listener of sessionListeners) {
        listener(instanceId, sessionId, message);
      }
    },
  };
}
