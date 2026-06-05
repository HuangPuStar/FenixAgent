# 远程节点标注与启动前连接检查

## 背景

系统中远程机器通过 WS 注册到 RCS，AgentConfig 可绑定 `machineId` 将实例调度到远程节点运行。当前远程节点在 UI 上没有任何视觉区分，且实例启动时不检查远程节点是否在线，导致离线节点上尝试启动实例时产生不明确的错误。

## 需求

1. **后端**：实例启动前检查远程节点 ACP WS 连接状态，不通则拒绝启动（HTTP 503）
2. **前端**：AgentSidebarTree 中，绑定远程节点的 agent 卡片显示「远程」徽章 + 在线/离线状态

## 设计

### 1. 后端：实例启动守卫

**改动文件**：`src/services/instance.ts`

**插入位置**：`spawnInstanceFromEnvironment()` 中，`nodeId` 确定之后、`facade.launchInstance()` 之前（约 line 166-169）

**逻辑**：

```typescript
if (nodeId !== "local-default") {
  const conn = findMachineConnectionById(nodeId);
  if (!conn) {
    throw new HTTPError(503, {
      error: { type: "MACHINE_OFFLINE", message: "远程节点未连接，无法启动实例" },
    });
  }
}
```

**影响范围**：
- 所有通过 `spawnInstanceFromEnvironment` 的路径（手动 API 创建、`ensureRunning` 自动启动）统一拦截
- 本地节点（`nodeId === "local-default"`）不受影响
- 不需要改动路由层，现有 try-catch 自动处理错误响应

**依赖**：从 `src/transport/acp-ws-handler.ts` 导入 `findMachineConnectionById`

### 2. 前端：AgentSidebarTree 远程徽章

**改动文件**：`web/src/pages/agent-panel/AgentSidebarTree.tsx`

**标注位置**：agent 卡片的名称/描述区域下方

**徽章内容**：
- 小圆点（在线绿色、离线灰色）+ 文字「远程」
- 仅当 `agentConfig.machineId` 存在时显示

**数据来源**：
- `agentConfig.machineId` 已在现有数据流中可用（通过 agent config API 返回）
- machine 在线/离线状态通过 `machine.status` 字段获取，需要 agent tree 数据加载时关联查询

**i18n**：徽章文字 "远程" / "Remote" 通过 `t()` 翻译，使用现有 agent panel 命名空间

## 不做的事

- 不新建 Machine 注册表前端页面
- 不增加 SSE 实时推送
- 不做主动 ping/pong 探测
- 不修改数据库 schema
- 不检查 file-ws 连接状态

## 验证标准

1. 远程节点离线时，通过 API 启动实例返回 503 + `MACHINE_OFFLINE`
2. 远程节点在线时，正常启动实例
3. 本地节点不受影响，行为不变
4. AgentSidebarTree 中，绑定远程节点的 agent 显示「远程」徽章
5. 未绑定远程节点的 agent 不显示徽章
