# 工作流异常日志补全 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全工作流执行链路中缺失的异常日志，使节点失败、DAG 异常、运行终态等信息在服务器日志中可见。

**Architecture:** 在 `packages/workflow-engine` 的调度器层和引擎门面层添加 `console.error` 日志。调度器记录节点级失败详情，引擎门面记录运行级终态摘要。同时在 `AgentExecutor` 中保留 AbortError 的原始超时信息。

**Tech Stack:** TypeScript, `console.error`（`workflow-engine` 包不依赖 `@fenix/logger`）

---

### Task 1: AgentExecutor 保留原始 AbortError 信息

**Files:**
- Modify: `packages/workflow-engine/src/executor/agent-executor.ts:66-67`

- [ ] **Step 1: 修改 AbortError 分支，在 WorkflowError details 中携带原始原因**

将 `agent-executor.ts` 第 66-67 行：
```typescript
if (error instanceof DOMException && error.name === "AbortError") {
  throw new WorkflowError("Node cancelled", WorkflowErrorCode.DAG_CANCELLED, { node_id: node.id });
}
```
改为：
```typescript
if (error instanceof DOMException && error.name === "AbortError") {
  throw new WorkflowError("Node cancelled", WorkflowErrorCode.DAG_CANCELLED, {
    node_id: node.id,
    abort_reason: error.message,
  });
}
```

- [ ] **Step 2: 运行测试确认无回归**

Run: `bun test packages/workflow-engine/src/__tests__/executor/agent-executor.test.ts`
Expected: 20 pass, 0 fail

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/executor/agent-executor.ts
git commit -m "fix(workflow): preserve AbortError reason in WorkflowError details"
```

---

### Task 2: DAGScheduler 补全节点失败和取消日志

**Files:**
- Modify: `packages/workflow-engine/src/scheduler/dag-scheduler.ts:314-345`

- [ ] **Step 1: 在 executeNode() catch 块中添加日志**

将 `dag-scheduler.ts` 第 314-345 行的 catch 块：
```typescript
    } catch (error) {
      // 处理 SUSPENDED
      if (error instanceof SuspendedError) {
        this.nodeStates.set(nodeId, "SUSPENDED" as NodeStatus);
        await this.emitEvent("audit.requested", nodeId, {
          display_data: error.displayData,
        });
        // 重新抛出让 run() 通过 allSettled 捕获
        throw error;
      }

      // 处理 AbortError（取消）
      if (error instanceof DOMException && error.name === "AbortError") {
        this.nodeStates.set(nodeId, "CANCELLED");
        await this.emitEvent("node.cancelled", nodeId);
        return;
      }

      // 节点失败（执行器内部已发射 node.failed 事件，此处不再重复）
      this.nodeStates.set(nodeId, "FAILED");

      // 保存失败输出，使前端能查看错误详情
      const failureOutput = this.extractFailureOutput(error);
      if (failureOutput) {
        this.nodeOutputs.set(nodeId, failureOutput);
        this.lastEventId = `evt_${nanoid(10)}`;
        await this.saveSnapshotAfterNode(nodeId, failureOutput);
      }

      // BFS 错误传播：标记下游为 SKIPPED
      await this.propagateFailure(nodeId);
    }
```
改为：
```typescript
    } catch (error) {
      // 处理 SUSPENDED
      if (error instanceof SuspendedError) {
        this.nodeStates.set(nodeId, "SUSPENDED" as NodeStatus);
        await this.emitEvent("audit.requested", nodeId, {
          display_data: error.displayData,
        });
        throw error;
      }

      const nodeType = this.nodeMap.get(nodeId)?.type ?? "unknown";

      // 处理 AbortError（取消 / 超时）
      if (error instanceof DOMException && error.name === "AbortError") {
        this.nodeStates.set(nodeId, "CANCELLED");
        await this.emitEvent("node.cancelled", nodeId);
        console.error(
          `[workflow] Node CANCELLED: nodeId=${nodeId} type=${nodeType} reason=${error.message}`,
        );
        return;
      }

      // 节点失败
      this.nodeStates.set(nodeId, "FAILED");

      const failureOutput = this.extractFailureOutput(error);
      if (failureOutput) {
        this.nodeOutputs.set(nodeId, failureOutput);
        this.lastEventId = `evt_${nanoid(10)}`;
        await this.saveSnapshotAfterNode(nodeId, failureOutput);
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorDetail =
        error instanceof WorkflowError && error.details?.abort_reason
          ? ` reason=${error.details.abort_reason as string}`
          : "";
      console.error(
        `[workflow] Node FAILED: nodeId=${nodeId} type=${nodeType} error=${errorMsg}${errorDetail}`,
      );

      // BFS 错误传播：标记下游为 SKIPPED
      await this.propagateFailure(nodeId);
    }
```

- [ ] **Step 2: 运行调度器测试确认无回归**

Run: `bun test packages/workflow-engine/src/__tests__/scheduler/dag-scheduler.test.ts`
Expected: 全部 pass

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/scheduler/dag-scheduler.ts
git commit -m "fix(workflow): add node failure and cancellation logs in DAGScheduler"
```

---

### Task 3: DAGScheduler run() 未预期异常日志

**Files:**
- Modify: `packages/workflow-engine/src/scheduler/dag-scheduler.ts:237-248`

- [ ] **Step 1: 在 run() 外层 catch 块中添加日志**

将 `dag-scheduler.ts` 第 237-248 行：
```typescript
    } catch (_error) {
      // 未预期的异常 → ERROR 状态
      const completedAt = new Date().toISOString();
      await this.emitEvent("dag.cancelled");
      const summary = this.buildSummary("ERROR", completedAt);
      return {
        runId: this.ctx.runId,
        status: "ERROR",
        summary,
        spawnedEnvIds: this.ctx.spawnedEnvIds ? [...this.ctx.spawnedEnvIds] : [],
      };
    }
```
改为：
```typescript
    } catch (error) {
      // 未预期的异常 → ERROR 状态
      console.error(`[workflow] DAG unexpected error: runId=${this.ctx.runId}`, error);
      const completedAt = new Date().toISOString();
      await this.emitEvent("dag.cancelled");
      const summary = this.buildSummary("ERROR", completedAt);
      return {
        runId: this.ctx.runId,
        status: "ERROR",
        summary,
        spawnedEnvIds: this.ctx.spawnedEnvIds ? [...this.ctx.spawnedEnvIds] : [],
      };
    }
```

- [ ] **Step 2: 运行调度器测试确认无回归**

Run: `bun test packages/workflow-engine/src/__tests__/scheduler/dag-scheduler.test.ts`
Expected: 全部 pass

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/scheduler/dag-scheduler.ts
git commit -m "fix(workflow): log unexpected errors in DAGScheduler.run()"
```

---

### Task 4: WorkflowEngine runAsync() 运行终态日志

**Files:**
- Modify: `packages/workflow-engine/src/engine/workflow-engine.ts:220-232`

- [ ] **Step 1: 在 runAsync 的 try 块 return 前添加终态日志**

将 `workflow-engine.ts` 第 220-232 行：
```typescript
      let result: DAGRunResult | undefined;
      try {
        const scheduler = new DAGScheduler(context);
        result = await scheduler.run();
        return result;
      } catch (err) {
        console.error(`[workflow-engine] runAsync ${runId} failed:`, err);
        throw err;
      } finally {
```
改为：
```typescript
      let result: DAGRunResult | undefined;
      try {
        const scheduler = new DAGScheduler(context);
        result = await scheduler.run();
        const ns = result.summary.node_summary;
        console.log(
          `[workflow] Run completed: runId=${runId} status=${result.status} nodes=${ns.total} completed=${ns.completed} failed=${ns.failed}`,
        );
        return result;
      } catch (err) {
        console.error(`[workflow] Run error: runId=${runId}`, err);
        throw err;
      } finally {
```

- [ ] **Step 2: 运行引擎测试确认无回归**

Run: `bun test packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts`
Expected: 全部 pass

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/engine/workflow-engine.ts
git commit -m "fix(workflow): add run completion summary log in WorkflowEngine.runAsync()"
```

---

### Task 5: Precheck 和最终验证

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck`
Expected: 格式化、类型检查、lint 全部通过

- [ ] **Step 2: 运行 workflow-engine 全部测试**

Run: `bun test packages/workflow-engine/src/__tests__/`
Expected: 全部 pass

- [ ] **Step 3: 运行后端 acp-transport 相关测试**

Run: `bun test src/__tests__/workflow-acp-transport.test.ts`
Expected: 5 pass

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "chore(workflow): final precheck pass for error logging"
```
