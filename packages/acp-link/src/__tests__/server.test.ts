import { describe, test, expect } from 'bun:test'
import {
  decodeClientWsMessage,
  MAX_CLIENT_WS_PAYLOAD_BYTES,
  type ServerConfig,
} from '../server.js'

describe('Server HTTP endpoints', () => {
  // package.json 入口验证
  test('package.json has correct bin and main entries', async () => {
    const pkg = await import('../../package.json', { with: { type: 'json' } })
    expect(pkg.default.name).toBe('acp-link')
    expect(pkg.default.main).toBe('./dist/server.js')
    expect(pkg.default.bin).toBeDefined()
    expect(pkg.default.bin['acp-link']).toBe('dist/cli/bin.js')
  })

  // ServerConfig 类型验证
  test('ServerConfig interface accepts all expected fields', () => {
    const config: ServerConfig = {
      port: 9315,
      host: 'localhost',
      command: 'echo',
      args: [],
      cwd: '/tmp',
    }
    expect(config.port).toBe(9315)
    expect(config.host).toBe('localhost')
    expect(config.command).toBe('echo')
  })
})

describe('WebSocket message types', () => {
  const clientMessageTypes = [
    'connect',
    'disconnect',
    'new_session',
    'prompt',
    'permission_response',
    'cancel',
    'set_session_model',
    'list_sessions',
    'load_session',
    'resume_session',
    'ping',
  ]

  // 消息类型计数验证
  test('all client message types are recognized', () => {
    expect(clientMessageTypes.length).toBe(11)
    expect(clientMessageTypes).toContain('ping')
    expect(clientMessageTypes).toContain('connect')
    expect(clientMessageTypes).toContain('cancel')
  })

  // 支持的消息载荷解码
  test('decodes supported client message payloads', () => {
    expect(decodeClientWsMessage('{"type":"ping"}')).toEqual({ type: 'ping' })
    expect(
      decodeClientWsMessage(
        Buffer.from('{"type":"prompt","payload":{"content":[]}}'),
      ),
    ).toEqual({ type: 'prompt', payload: { content: [] } })
    expect(
      decodeClientWsMessage(
        new TextEncoder().encode('{"type":"cancel"}').buffer,
      ),
    ).toEqual({ type: 'cancel' })
    expect(
      decodeClientWsMessage([
        Buffer.from('{"type":"list_sessions","payload":{"cursor":"'),
        Buffer.from('next"}}'),
      ]),
    ).toEqual({
      type: 'list_sessions',
      payload: { cwd: undefined, cursor: 'next' },
    })
  })

  // 非法消息载荷拒绝
  test('rejects malformed typed client payloads', () => {
    expect(() => decodeClientWsMessage('{"type":"prompt"}')).toThrow(
      'Invalid prompt payload',
    )
    expect(() =>
      decodeClientWsMessage('{"type":"load_session","payload":{}}'),
    ).toThrow('Invalid load_session payload')
    expect(() => decodeClientWsMessage('{"type":"unknown"}')).toThrow(
      'Unknown message type',
    )
    expect(() =>
      decodeClientWsMessage(
        '{"type":"new_session","payload":{"permissionMode":123}}',
      ),
    ).toThrow('Invalid new_session.permissionMode')
    expect(() =>
      decodeClientWsMessage(
        '{"type":"new_session","payload":{"permissionMode":{}}}',
      ),
    ).toThrow('Invalid new_session.permissionMode')
    expect(() =>
      decodeClientWsMessage(
        '{"type":"new_session","payload":{"permissionMode":null}}',
      ),
    ).toThrow('Invalid new_session.permissionMode')
  })

  // 超大消息拒绝
  test('rejects oversized client message payloads before decoding', () => {
    const payload = 'x'.repeat(MAX_CLIENT_WS_PAYLOAD_BYTES + 1)
    expect(() => decodeClientWsMessage(payload)).toThrow(
      'WebSocket message too large',
    )
  })
})

describe('Heartbeat constants', () => {
  // 权限超时常量验证
  test('PERMISSION_TIMEOUT_MS is 5 minutes', () => {
    const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000
    expect(PERMISSION_TIMEOUT_MS).toBe(300_000)
  })

  // 心跳间隔常量验证
  test('HEARTBEAT_INTERVAL_MS is 30 seconds', () => {
    const HEARTBEAT_INTERVAL_MS = 30_000
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000)
  })
})
