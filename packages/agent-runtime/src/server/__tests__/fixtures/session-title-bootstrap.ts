import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocManager, getSessionsMap, type SessionConnection } from "@fenix/chat-channel/server";
import {
  getChatChannelController,
  resetChatChannelBootstrap,
  setChatChannelBootstrapDeps,
} from "../../services/chat-channel-bootstrap";
import { initializeAgentRuntimeModuleConfig } from "../../testing";

const root = await mkdtemp(join(tmpdir(), "fenix-title-bootstrap-"));
try {
  initializeAgentRuntimeModuleConfig({ workspaceRoot: root });
  const firstManager = new DocManager();
  setChatChannelBootstrapDeps({ docManager: firstManager });
  const controller = getChatChannelController();
  const rcsSessionId = "rcs-user-1-instance-1";
  await firstManager.openChat(rcsSessionId);
  await firstManager.openSession("user-1", "agent-1", rcsSessionId);
  firstManager.processNormalizedEvent(rcsSessionId, {
    type: "session_list",
    update: { sessions: [{ sessionId: "ses-1", title: "Agent title" }] },
    content: null,
  });

  const connection: SessionConnection = {
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId,
    acpSessionId: "ses-1",
    agentStatusReceived: true,
    sessionLoaded: false,
    workspacePath: "/trusted",
    sendToRelay() {
      throw new Error("rename must stay in Fenix");
    },
    getNextRpcId: () => 1,
  };
  const statuses: string[] = [];
  const errors: string[] = [];
  await controller.sessionChannel.handleAction(
    connection,
    { action: "rename_session", commandId: "rename-1", sessionId: "ses-1", title: "Saved title" },
    {
      sendAck: (ack) => {
        statuses.push(ack.status);
      },
      sendError: (error) => {
        errors.push(error.error.type);
      },
    },
  );
  assert.deepEqual(statuses, ["accepted", "committed"]);
  assert.deepEqual(errors, []);
  await firstManager.closeAll();

  resetChatChannelBootstrap();
  const restoredManager = new DocManager();
  setChatChannelBootstrapDeps({ docManager: restoredManager });
  getChatChannelController();
  await restoredManager.openChat(rcsSessionId);
  await restoredManager.openSession("user-1", "agent-1", rcsSessionId);
  restoredManager.processNormalizedEvent(rcsSessionId, {
    type: "session_list",
    update: { sessions: [{ sessionId: "ses-1", title: "Agent title" }] },
    content: null,
  });
  const restoredSession = restoredManager.getSessionYdoc(rcsSessionId);
  assert.ok(restoredSession);
  assert.equal(getSessionsMap(restoredSession).get("ses-1")?.get("title"), "Saved title");
  await restoredManager.closeAll();
} finally {
  resetChatChannelBootstrap();
  setChatChannelBootstrapDeps(null);
  await rm(root, { recursive: true, force: true });
}
