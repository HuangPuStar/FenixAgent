import type { ServerWebSocket } from 'bun'
import { spawn, type ChildProcess } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { decodeJsonWsMessage, WsPayloadTooLargeError } from './ws-message.js'
import type {
  AgentCapabilities,
  PromptCapabilities,
  SessionModelState,
  PermissionResponsePayload,
  ContentBlock,
  ProxyMessage,
} from './types.js'

export { MAX_CLIENT_WS_PAYLOAD_BYTES } from './ws-message.js'

export interface ServerConfig {
  port: number
  host: string
  command: string
  args: string[]
  cwd: string
}

export interface AcpServerHandle {
  close: () => void
}

// Pending permission request
interface PendingPermission {
  resolve: (
    outcome:
      | { outcome: 'cancelled' }
      | { outcome: 'selected'; optionId: string },
  ) => void
  timeout: ReturnType<typeof setTimeout>
}

// Track connected clients and their agent connections
interface ClientState {
  process: ChildProcess | null
  connection: acp.ClientSideConnection | null
  sessionId: string | null
  pendingPermissions: Map<string, PendingPermission>
  agentCapabilities: AgentCapabilities | null
  promptCapabilities: PromptCapabilities | null
  modelState: SessionModelState | null
  isAlive: boolean
}

// Permission request timeout (5 minutes)
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

// Heartbeat interval for WebSocket ping/pong (30 seconds)
const HEARTBEAT_INTERVAL_MS = 30_000

// Generate unique request ID
function generateRequestId(): string {
  return `perm_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

function cancelPendingPermissions(clientState: ClientState): void {
  for (const [, pending] of clientState.pendingPermissions) {
    clearTimeout(pending.timeout)
    pending.resolve({ outcome: 'cancelled' })
  }
  clientState.pendingPermissions.clear()
}

// ---------------------------------------------------------------------------
// Pure validation / decoding (no module-level state)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalStringField(
  payload: Record<string, unknown>,
  key: string,
  source: string,
): string | undefined {
  if (!Object.hasOwn(payload, key)) return undefined
  const value = payload[key]
  if (typeof value === 'string') return value
  throw new Error(`Invalid ${source}: expected a string`)
}

function payloadRecord(value: unknown, type: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${type} payload`)
  }
  return value
}

function optionalPayloadRecord(
  value: unknown,
  type: string,
): Record<string, unknown> {
  if (value === undefined) return {}
  return payloadRecord(value, type)
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function decodeContentBlocks(value: unknown): ContentBlock[] {
  if (
    !Array.isArray(value) ||
    !value.every(block => isRecord(block) && typeof block.type === 'string')
  ) {
    throw new Error('Invalid prompt payload')
  }
  return value as ContentBlock[]
}

function decodePermissionResponsePayload(
  value: unknown,
): PermissionResponsePayload {
  const payload = payloadRecord(value, 'permission_response')
  if (typeof payload.requestId !== 'string' || !isRecord(payload.outcome)) {
    throw new Error('Invalid permission_response payload')
  }
  if (payload.outcome.outcome === 'cancelled') {
    return { requestId: payload.requestId, outcome: { outcome: 'cancelled' } }
  }
  if (
    payload.outcome.outcome === 'selected' &&
    typeof payload.outcome.optionId === 'string'
  ) {
    return {
      requestId: payload.requestId,
      outcome: { outcome: 'selected', optionId: payload.outcome.optionId },
    }
  }
  throw new Error('Invalid permission_response payload')
}

function decodeClientMessage(message: Record<string, unknown>): ProxyMessage {
  if (typeof message.type !== 'string') {
    throw new Error('Invalid WebSocket message payload')
  }

  switch (message.type) {
    case 'connect':
    case 'disconnect':
    case 'cancel':
    case 'ping':
      return { type: message.type }
    case 'new_session': {
      const payload = optionalPayloadRecord(message.payload, 'new_session')
      return {
        type: 'new_session',
        payload: {
          cwd: optionalStringField(payload, 'cwd', 'new_session.cwd'),
          permissionMode: optionalStringField(
            payload,
            'permissionMode',
            'new_session.permissionMode',
          ),
        },
      }
    }
    case 'prompt': {
      const payload = payloadRecord(message.payload, 'prompt')
      return {
        type: 'prompt',
        payload: { content: decodeContentBlocks(payload.content) },
      }
    }
    case 'permission_response':
      return {
        type: 'permission_response',
        payload: decodePermissionResponsePayload(message.payload),
      }
    case 'set_session_model': {
      const payload = payloadRecord(message.payload, 'set_session_model')
      if (typeof payload.modelId !== 'string') {
        throw new Error('Invalid set_session_model payload')
      }
      return {
        type: 'set_session_model',
        payload: { modelId: payload.modelId },
      }
    }
    case 'list_sessions': {
      const payload = optionalRecord(message.payload)
      return {
        type: 'list_sessions',
        payload: {
          cwd: optionalString(payload.cwd),
          cursor: optionalString(payload.cursor),
        },
      }
    }
    case 'load_session':
    case 'resume_session': {
      const payload = payloadRecord(message.payload, message.type)
      if (typeof payload.sessionId !== 'string') {
        throw new Error(`Invalid ${message.type} payload`)
      }
      return {
        type: message.type,
        payload: {
          sessionId: payload.sessionId,
          cwd: optionalString(payload.cwd),
        },
      }
    }
    case 'browser_tool_result':
      return message as unknown as ProxyMessage
    default:
      throw new Error(`Unknown message type: ${message.type}`)
  }
}

export function decodeClientWsMessage(data: unknown): ProxyMessage {
  return decodeClientMessage(decodeJsonWsMessage(data))
}

// ---------------------------------------------------------------------------
// Factory: creates a per-instance ACP WS server using Bun native API
// ---------------------------------------------------------------------------

export function createAcpServer(config: ServerConfig): AcpServerHandle {
  const { port, host, command, args, cwd } = config

  // Per-instance state — no module-level globals
  const clients = new Map<ServerWebSocket, ClientState>()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  // --- Helpers (closures over local `clients`) ---

  function send(ws: ServerWebSocket, type: string, payload?: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }))
    }
  }

  function createClient(ws: ServerWebSocket, clientState: ClientState): acp.Client {
    return {
      async requestPermission(params) {
        const requestId = generateRequestId()

        const outcomePromise = new Promise<
          { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }
        >(resolve => {
          const timeout = setTimeout(() => {
            console.warn('permission request timed out:', requestId)
            clientState.pendingPermissions.delete(requestId)
            resolve({ outcome: 'cancelled' })
          }, PERMISSION_TIMEOUT_MS)

          clientState.pendingPermissions.set(requestId, { resolve, timeout })
        })

        send(ws, 'permission_request', {
          requestId,
          sessionId: params.sessionId,
          options: params.options,
          toolCall: params.toolCall,
        })

        const outcome = await outcomePromise
        return { outcome }
      },

      async sessionUpdate(params) {
        send(ws, 'session_update', params)
      },

      async readTextFile(_params) {
        return { content: '' }
      },

      async writeTextFile(_params) {
        return {}
      },
    }
  }

  function handlePermissionResponse(
    ws: ServerWebSocket,
    payload: {
      requestId: string
      outcome:
        | { outcome: 'cancelled' }
        | { outcome: 'selected'; optionId: string }
    },
  ): void {
    const state = clients.get(ws)
    if (!state) {
      console.warn('permission response from unknown client')
      return
    }

    const pending = state.pendingPermissions.get(payload.requestId)
    if (!pending) {
      console.warn('permission response for unknown request:', payload.requestId)
      return
    }

    clearTimeout(pending.timeout)
    state.pendingPermissions.delete(payload.requestId)
    pending.resolve(payload.outcome)
  }

  // --- Agent lifecycle handlers ---

  async function handleConnect(ws: ServerWebSocket): Promise<void> {
    const state = clients.get(ws)
    if (!state) return

    // If already connected to a running agent, just resend status
    if (
      state.connection &&
      state.process &&
      !state.process.killed &&
      state.process.exitCode === null
    ) {
      console.log('agent already connected, resending status')
      send(ws, 'status', {
        connected: true,
        agentInfo: { name: command },
        capabilities: state.agentCapabilities,
      })
      return
    }

    // Kill existing process if any (only if not healthy)
    if (state.process) {
      cancelPendingPermissions(state)
      state.process.kill()
      state.process = null
      state.connection = null
    }

    try {
      console.log('spawning agent:', command, args)

      const agentProcess = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'inherit'],
        env: process.env,
      })

      state.process = agentProcess

      agentProcess.on('exit', code => {
        console.log('agent process exited:', code)
        if (state.process === agentProcess) {
          state.process = null
          state.connection = null
          state.sessionId = null
        }
      })

      const input = Writable.toWeb(
        agentProcess.stdin!,
      ) as unknown as WritableStream<Uint8Array>
      const output = Readable.toWeb(
        agentProcess.stdout!,
      ) as unknown as ReadableStream<Uint8Array>

      const stream = acp.ndJsonStream(input, output)
      const connection = new acp.ClientSideConnection(
        _agent => createClient(ws, state),
        stream,
      )

      state.connection = connection

      const initResult = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'zed', version: '1.0.0' },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      })

      const agentCaps = initResult.agentCapabilities
      state.agentCapabilities = agentCaps
        ? {
            _meta: agentCaps._meta,
            loadSession: agentCaps.loadSession,
            mcpCapabilities: agentCaps.mcpCapabilities,
            promptCapabilities: agentCaps.promptCapabilities,
            sessionCapabilities: agentCaps.sessionCapabilities,
          }
        : null
      state.promptCapabilities = agentCaps?.promptCapabilities ?? null

      console.log(
        'agent initialized:',
        'protocolVersion=' + initResult.protocolVersion,
        'loadSession=' + !!state.agentCapabilities?.loadSession,
        'sessionList=' + !!state.agentCapabilities?.sessionCapabilities?.list,
        'sessionResume=' +
          !!state.agentCapabilities?.sessionCapabilities?.resume,
        'hasMcp=' + !!state.agentCapabilities?.mcpCapabilities,
      )

      send(ws, 'status', {
        connected: true,
        agentInfo: initResult.agentInfo,
        capabilities: state.agentCapabilities,
      })

      connection.closed.then(() => {
        console.log('agent connection closed')
        state.connection = null
        state.sessionId = null
        send(ws, 'status', { connected: false })
      })
    } catch (error) {
      console.error('agent connect failed:', (error as Error).message)
      send(ws, 'error', {
        message: `Failed to connect: ${(error as Error).message}`,
      })
    }
  }

  async function handleNewSession(
    ws: ServerWebSocket,
    params: { cwd?: string },
  ): Promise<void> {
    const state = clients.get(ws)
    if (!state?.connection) {
      console.warn('handleNewSession: not connected to agent')
      send(ws, 'error', { message: 'Not connected to agent' })
      return
    }

    try {
      const sessionCwd = params.cwd || cwd
      const result = await state.connection.newSession({
        cwd: sessionCwd,
        mcpServers: [],
      })

      state.sessionId = result.sessionId
      state.modelState = result.models ?? null
      console.log('session created:', result.sessionId, 'cwd:', sessionCwd)

      send(ws, 'session_created', {
        ...result,
        promptCapabilities: state.promptCapabilities,
        models: state.modelState,
      })
    } catch (error) {
      console.error('session create failed:', (error as Error).message)
      send(ws, 'error', {
        message: `Failed to create session: ${(error as Error).message}`,
      })
    }
  }

  async function handleListSessions(
    ws: ServerWebSocket,
    params: { cwd?: string; cursor?: string },
  ): Promise<void> {
    const state = clients.get(ws)
    if (!state?.connection) {
      console.warn('handleListSessions: not connected to agent')
      send(ws, 'error', { message: 'Not connected to agent' })
      return
    }

    if (!state.agentCapabilities?.sessionCapabilities?.list) {
      send(ws, 'error', {
        message: 'Listing sessions is not supported by this agent',
      })
      return
    }

    try {
      const result = await state.connection.listSessions({
        cwd: params.cwd,
        cursor: params.cursor,
      })

      const MAX_SESSIONS = 20
      const sessions = result.sessions.slice(0, MAX_SESSIONS)
      console.log(
        'sessions listed:',
        'total=' + result.sessions.length,
        'returned=' + sessions.length,
      )

      send(ws, 'session_list', {
        sessions: sessions.map((s: acp.SessionInfo) => ({
          _meta: s._meta,
          cwd: s.cwd,
          sessionId: s.sessionId,
          title: s.title,
          updatedAt: s.updatedAt,
        })),
        nextCursor: result.nextCursor,
        _meta: result._meta,
      })
    } catch (error) {
      console.error('session list failed:', (error as Error).message)
      send(ws, 'error', {
        message: `Failed to list sessions: ${(error as Error).message}`,
      })
    }
  }

  async function handleLoadSession(
    ws: ServerWebSocket,
    params: { sessionId: string; cwd?: string },
  ): Promise<void> {
    const state = clients.get(ws)
    if (!state?.connection) {
      console.warn('handleLoadSession: not connected to agent')
      send(ws, 'error', { message: 'Not connected to agent' })
      return
    }

    if (!state.agentCapabilities?.loadSession) {
      send(ws, 'error', {
        message: 'Loading sessions is not supported by this agent',
      })
      return
    }

    try {
      const sessionCwd = params.cwd || cwd
      const sessionId = params.sessionId
      const result = await state.connection.loadSession({
        sessionId,
        cwd: sessionCwd,
        mcpServers: [],
      })

      state.sessionId = sessionId
      state.modelState = result.models ?? null
      console.log('session loaded:', sessionId, 'cwd:', sessionCwd)

      send(ws, 'session_loaded', {
        sessionId,
        promptCapabilities: state.promptCapabilities,
        models: state.modelState,
      })
    } catch (error) {
      console.error('session load failed:', (error as Error).message)
      send(ws, 'error', {
        message: `Failed to load session: ${(error as Error).message}`,
      })
    }
  }

  async function handleResumeSession(
    ws: ServerWebSocket,
    params: { sessionId: string; cwd?: string },
  ): Promise<void> {
    const state = clients.get(ws)
    if (!state?.connection) {
      console.warn('handleResumeSession: not connected to agent')
      send(ws, 'error', { message: 'Not connected to agent' })
      return
    }

    if (!state.agentCapabilities?.sessionCapabilities?.resume) {
      send(ws, 'error', {
        message: 'Resuming sessions is not supported by this agent',
      })
      return
    }

    try {
      const sessionCwd = params.cwd || cwd
      const sessionId = params.sessionId
      const result = await state.connection.unstable_resumeSession({
        sessionId,
        cwd: sessionCwd,
      })

      state.sessionId = sessionId
      state.modelState = result.models ?? null
      console.log('session resumed:', sessionId, 'cwd:', sessionCwd)

      send(ws, 'session_resumed', {
        sessionId,
        promptCapabilities: state.promptCapabilities,
        models: state.modelState,
      })
    } catch (error) {
      console.error('session resume failed:', (error as Error).message)
      send(ws, 'error', {
        message: `Failed to resume session: ${(error as Error).message}`,
      })
    }
  }

  async function handlePrompt(
    ws: ServerWebSocket,
    params: { content: ContentBlock[] },
  ): Promise<void> {
    const state = clients.get(ws)
    if (!state?.connection || !state.sessionId) {
      send(ws, 'error', { message: 'No active session' })
      return
    }

    try {
      const result = await state.connection.prompt({
        sessionId: state.sessionId,
        prompt: params.content as acp.ContentBlock[],
      })

      console.log('prompt completed, stopReason:', result.stopReason)
      send(ws, 'prompt_complete', result)
    } catch (error) {
      console.error('prompt failed:', (error as Error).message)
      send(ws, 'error', { message: `Prompt failed: ${(error as Error).message}` })
    }
  }

  function handleDisconnect(ws: ServerWebSocket): void {
    const state = clients.get(ws)
    if (!state) return

    if (state.process) {
      state.process.kill()
      state.process = null
    }
    state.connection = null
    state.sessionId = null

    send(ws, 'status', { connected: false })
  }

  async function handleCancel(ws: ServerWebSocket): Promise<void> {
    const state = clients.get(ws)
    if (!state?.connection || !state.sessionId) {
      console.warn('cancel requested but no active session')
      return
    }

    console.log('cancel requested, sessionId:', state.sessionId)
    cancelPendingPermissions(state)

    try {
      await state.connection.cancel({ sessionId: state.sessionId })
      console.log('cancel sent, sessionId:', state.sessionId)
    } catch (error) {
      console.error('cancel failed:', (error as Error).message)
    }
  }

  async function handleSetSessionModel(
    ws: ServerWebSocket,
    params: { modelId: string },
  ): Promise<void> {
    const state = clients.get(ws)
    if (!state?.connection || !state.sessionId) {
      send(ws, 'error', { message: 'No active session' })
      return
    }

    if (!state.modelState) {
      send(ws, 'error', {
        message: 'Model selection not supported by this agent',
      })
      return
    }

    try {
      console.log(
        'setting model, sessionId:',
        state.sessionId,
        'modelId:',
        params.modelId,
      )
      await state.connection.unstable_setSessionModel({
        sessionId: state.sessionId,
        modelId: params.modelId,
      })
      state.modelState = { ...state.modelState, currentModelId: params.modelId }
      send(ws, 'model_changed', { modelId: params.modelId })
      console.log('model changed:', params.modelId)
    } catch (error) {
      console.error('set model failed:', (error as Error).message)
      send(ws, 'error', {
        message: `Failed to set model: ${(error as Error).message}`,
      })
    }
  }

  async function dispatchClientMessage(
    ws: ServerWebSocket,
    data: ProxyMessage,
  ): Promise<void> {
    console.log('[acp-server] dispatch:', data.type, 'hasSession:', !!clients.get(ws)?.sessionId)
    switch (data.type) {
      case 'connect':
        await handleConnect(ws)
        break
      case 'disconnect':
        handleDisconnect(ws)
        break
      case 'new_session':
        await handleNewSession(ws, data.payload ?? {})
        break
      case 'prompt':
        await handlePrompt(ws, data.payload)
        break
      case 'permission_response':
        handlePermissionResponse(ws, data.payload)
        break
      case 'cancel':
        await handleCancel(ws)
        break
      case 'set_session_model':
        await handleSetSessionModel(ws, data.payload)
        break
      case 'list_sessions':
        await handleListSessions(ws, data.payload ?? {})
        break
      case 'load_session':
        await handleLoadSession(ws, data.payload)
        break
      case 'resume_session':
        await handleResumeSession(ws, data.payload)
        break
      case 'ping':
        send(ws, 'pong')
        break
      case 'browser_tool_result':
        break
    }
  }

  // --- Bun native server ---

  const server = Bun.serve({
    port,
    hostname: host,
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' })
      }
      if (url.pathname === '/ws') {
        if (server.upgrade(req)) {
          return
        }
        return new Response('WebSocket upgrade failed', { status: 500 })
      }
      return new Response('Not Found', { status: 404 })
    },
    websocket: {
      open(ws) {
        console.log('client connected')
        const state: ClientState = {
          process: null,
          connection: null,
          sessionId: null,
          pendingPermissions: new Map(),
          agentCapabilities: null,
          promptCapabilities: null,
          modelState: null,
          isAlive: true,
        }
        clients.set(ws, state)
      },
      async message(ws, raw) {
        try {
          const data = decodeClientWsMessage(raw)
          console.log(`[acp-server] received: type=${data.type}`)
          await dispatchClientMessage(ws, data)
        } catch (error) {
          if (error instanceof WsPayloadTooLargeError) {
            console.warn('message too large:', error.message)
            ws.close(1009, 'message too large')
            return
          }
          console.error('message error:', (error as Error).message)
          send(ws, 'error', { message: `Error: ${(error as Error).message}` })
        }
      },
      close(ws) {
        console.log('client disconnected')
        const state = clients.get(ws)
        if (state) {
          cancelPendingPermissions(state)
        }
        handleDisconnect(ws)
        clients.delete(ws)
      },
      pong(ws) {
        const state = clients.get(ws)
        if (state) {
          state.isAlive = true
        }
      },
    },
  })

  // Heartbeat: periodically ping all connected clients
  heartbeatTimer = setInterval(() => {
    for (const [ws, state] of clients) {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        clients.delete(ws)
        continue
      }
      if (!state.isAlive) {
        console.log('heartbeat timeout, closing')
        ws.close()
        continue
      }
      state.isAlive = false
      ws.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)

  const displayUrl = `ws://${host === '0.0.0.0' ? 'localhost' : host}:${server.port}/ws`
  console.log(`[acp-server] started on ${displayUrl}, agent: ${command} ${args.join(' ')}`)

  return {
    close() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      for (const [, cs] of clients) {
        cancelPendingPermissions(cs)
        if (cs.process) cs.process.kill()
      }
      clients.clear()
      server.stop()
    },
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function startServer(config: ServerConfig): Promise<void> {
  const handle = createAcpServer(config)

  const displayUrl = `ws://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/ws`

  const agentDisplay =
    config.args.length > 0
      ? `${config.command} ${config.args.join(' ')}`
      : config.command

  console.log()
  console.log(`  🚀 ACP Proxy Server`)
  console.log()
  console.log(`  Connection:`)
  console.log(`    URL:   ${displayUrl}`)
  console.log()
  console.log(`  📦 Agent: ${agentDisplay}`)
  console.log(`     CWD:   ${config.cwd}`)
  console.log()
  console.log(`  Press Ctrl+C to stop`)
  console.log()

  const shutdown = () => {
    handle.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep the process running
  await new Promise<void>(() => {})
}
