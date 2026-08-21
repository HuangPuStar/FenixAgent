import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { inspectRemoteMcpServer } from "../services/mcp-inspector";

const connectSpy = spyOn(Client.prototype, "connect");
const closeClientSpy = spyOn(Client.prototype, "close");
const listToolsSpy = spyOn(Client.prototype, "listTools");
const serverVersionSpy = spyOn(Client.prototype, "getServerVersion");
const closeSseSpy = spyOn(SSEClientTransport.prototype, "close");
const closeHttpSpy = spyOn(StreamableHTTPClientTransport.prototype, "close");

function installReachableServer(options?: { closeClientFails?: boolean; closeTransportFails?: boolean }) {
  connectSpy.mockImplementation(async () => undefined);
  closeClientSpy.mockImplementation(async () => {
    if (options?.closeClientFails) throw new Error("客户端关闭失败");
  });
  closeSseSpy.mockImplementation(async () => {
    if (options?.closeTransportFails) throw new Error("SSE 关闭失败");
  });
  closeHttpSpy.mockImplementation(async () => {
    if (options?.closeTransportFails) throw new Error("HTTP 关闭失败");
  });
  serverVersionSpy.mockReturnValue({ name: "安全工具服务", version: "1.2.3" });
  listToolsSpy.mockResolvedValue({
    tools: [
      { name: "审计", description: "读取审计日志", inputSchema: { type: "object" } },
      { name: "状态", inputSchema: { type: "object", properties: { verbose: { type: "boolean" } } } },
    ],
  });
}

beforeEach(() => {
  connectSpy.mockClear();
  closeClientSpy.mockClear();
  listToolsSpy.mockClear();
  serverVersionSpy.mockClear();
  closeSseSpy.mockClear();
  closeHttpSpy.mockClear();
  installReachableServer();
});

describe("MCP 检查器隔离、错误与资源释放", () => {
  test.each([
    ["默认超时", "https://mcp.example.test/tools", undefined, undefined],
    ["显式短超时", "https://mcp.example.test/tools", undefined, 1],
    ["显式长超时", "https://mcp.example.test/tools", undefined, 60000],
    ["携带认证头", "https://mcp.example.test/tools", { authorization: "Bearer redacted" }, 50],
    ["携带租户头", "https://mcp.example.test/tools", { "x-tenant-id": "tenant-a" }, 50],
    ["携带多个头", "https://mcp.example.test/tools", { accept: "application/json", "x-request-id": "r-1" }, 50],
    ["保留查询参数", "https://mcp.example.test/tools?scope=read", undefined, 50],
    ["保留端口", "https://mcp.example.test:9443/tools", undefined, 50],
    ["支持路径前缀", "https://mcp.example.test/api/mcp", undefined, 50],
    ["支持连字符路径", "https://mcp.example.test/mcp-tools", undefined, 50],
    ["支持数字路径", "https://mcp.example.test/v1/tools", undefined, 50],
    ["支持锚点 URL", "https://mcp.example.test/tools#read", undefined, 50],
    ["支持本地回环地址", "http://127.0.0.1:3000/mcp", undefined, 50],
    ["支持 localhost 地址", "http://localhost:3000/mcp", undefined, 50],
    ["支持大写请求头", "https://mcp.example.test/tools", { Authorization: "masked" }, 50],
    ["支持空请求头", "https://mcp.example.test/tools", {}, 50],
    ["支持语言头", "https://mcp.example.test/tools", { "accept-language": "zh-CN" }, 50],
    ["支持追踪头", "https://mcp.example.test/tools", { traceparent: "00-abc-def-01" }, 50],
    ["支持组织头", "https://mcp.example.test/tools", { "x-organization": "org-a" }, 50],
    ["支持版本路径", "https://mcp.example.test/v2026/mcp", undefined, 50],
  ])("Streamable HTTP 成功时%s", async (_name, url, headers, timeout) => {
    const result = await inspectRemoteMcpServer(url, headers, timeout);

    expect(result).toEqual({
      reachable: true,
      protocol: true,
      serverName: "安全工具服务",
      serverVersion: "1.2.3",
      tools: [
        { name: "审计", description: "读取审计日志", inputSchema: { type: "object" } },
        { name: "状态", inputSchema: { type: "object", properties: { verbose: { type: "boolean" } } } },
      ],
      transport: "streamable-http",
    });
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(closeClientSpy).toHaveBeenCalledTimes(1);
    expect(closeHttpSpy).toHaveBeenCalledTimes(1);
    expect(closeSseSpy).not.toHaveBeenCalled();
  });

  test.each([
    "Streamable HTTP 连接拒绝",
    "Streamable HTTP 超时",
    "Streamable HTTP 证书错误",
    "Streamable HTTP 协议错误",
    "Streamable HTTP 服务端错误",
    "Streamable HTTP 限流",
    "Streamable HTTP 负载过高",
    "Streamable HTTP 请求中止",
    "Streamable HTTP 响应损坏",
    "Streamable HTTP 身份验证失败",
    "Streamable HTTP 授权失败",
    "Streamable HTTP 路由缺失",
    "Streamable HTTP 网关错误",
    "Streamable HTTP 服务不可用",
    "Streamable HTTP 重定向失败",
    "Streamable HTTP 内容类型错误",
    "Streamable HTTP 连接重置",
    "Streamable HTTP DNS 失败",
    "Streamable HTTP 空响应",
    "Streamable HTTP 握手失败",
  ])("%s 时回退 SSE 且释放 SSE 资源", async () => {
    connectSpy.mockImplementationOnce(async () => {
      throw new Error("首选传输不可用");
    });

    const result = await inspectRemoteMcpServer("https://mcp.example.test/tools", { "x-tenant-id": "tenant-a" }, 20);

    expect(result.transport).toBe("sse");
    expect(result.reachable).toBe(true);
    expect(result.tools.map((tool) => tool.name)).toEqual(["审计", "状态"]);
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(closeClientSpy).toHaveBeenCalledTimes(1);
    expect(closeSseSpy).toHaveBeenCalledTimes(1);
  });

  test.each([
    "网络不可达",
    "连接超时",
    "认证被拒绝",
    "访问被拒绝",
    "服务器限流",
    "服务端异常",
    "证书校验失败",
    "DNS 解析失败",
    "连接被重置",
    "协议协商失败",
  ])("SSE 也失败时%s不泄露成功状态", async (reason) => {
    connectSpy.mockImplementation(async () => {
      throw new Error(reason);
    });

    const result = await inspectRemoteMcpServer("https://mcp.example.test/tools");

    expect(result).toEqual({ reachable: false, protocol: false, tools: [], message: reason });
    expect(closeClientSpy).not.toHaveBeenCalled();
    expect(closeHttpSpy).not.toHaveBeenCalled();
    expect(closeSseSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["客户端关闭失败", { closeClientFails: true }],
    ["传输关闭失败", { closeTransportFails: true }],
    ["两个关闭都失败", { closeClientFails: true, closeTransportFails: true }],
    ["客户端关闭失败仍保留工具", { closeClientFails: true }],
    ["传输关闭失败仍保留版本", { closeTransportFails: true }],
    ["两个关闭失败仍报告可达", { closeClientFails: true, closeTransportFails: true }],
    ["客户端关闭失败不触发 SSE", { closeClientFails: true }],
    ["传输关闭失败不触发 SSE", { closeTransportFails: true }],
    ["关闭失败不改变协议状态", { closeClientFails: true, closeTransportFails: true }],
    ["关闭失败不丢失服务名", { closeClientFails: true, closeTransportFails: true }],
  ])("资源释放阶段%s不会覆盖已获得的检查结果", async (_name, options) => {
    installReachableServer(options);

    const result = await inspectRemoteMcpServer("https://mcp.example.test/tools");

    expect(result.reachable).toBe(true);
    expect(result.protocol).toBe(true);
    expect(result.serverName).toBe("安全工具服务");
    expect(result.tools).toHaveLength(2);
    expect(closeClientSpy).toHaveBeenCalledTimes(1);
    expect(closeHttpSpy).toHaveBeenCalledTimes(1);
  });

  test.each([
    "并发租户一",
    "并发租户二",
    "并发租户三",
    "并发租户四",
    "并发租户五",
    "并发租户六",
    "并发租户七",
    "并发租户八",
    "并发租户九",
    "并发租户十",
  ])("%s 的检查请求各自建立并释放连接", async (_name) => {
    const results = await Promise.all([
      inspectRemoteMcpServer("https://mcp.example.test/a", { "x-tenant-id": "tenant-a" }),
      inspectRemoteMcpServer("https://mcp.example.test/b", { "x-tenant-id": "tenant-b" }),
    ]);

    expect(results.map((result) => result.transport)).toEqual(["streamable-http", "streamable-http"]);
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(closeClientSpy).toHaveBeenCalledTimes(2);
    expect(closeHttpSpy).toHaveBeenCalledTimes(2);
  });
});
