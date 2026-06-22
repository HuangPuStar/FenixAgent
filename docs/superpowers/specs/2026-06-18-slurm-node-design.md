# SlurmNode — 基于 CustomNode 的 Slurm 执行器

> Design 2/2 — 依赖 [Design 1: 自定义节点插件系统](./2026-06-18-custom-node-plugin-design.md)。
>
> 2026-06-18 · `packages/workflow-engine/`

---

## 1. 概述

### 1.1 做什么

在 Design 1 的 `CustomNode` 接口之上，提供 `SlurmNode` abstract class，封装 SSH 远程执行 + Slurm 作业提交/轮询/结果收集的完整生命周期。用户继承 `SlurmNode` 后只需覆写 `buildScript(ctx)` 返回具体 bash 命令，即可将工具投递到 HPC 集群。

### 1.2 与 Design 1 的关系

```
Design 1                          Design 2
────────                          ────────
CustomNode (interface)    ←────   SlurmNode (abstract class)
  ├─ name                           ├─ slurmConfig: SlurmConfig
  ├─ description                    ├─ buildScript(ctx): string    ← 用户覆写
  ├─ inputs: InputDef[]             ├─ preCleanup?(ctx): string    ← 用户可选覆写
  ├─ produces: string[]             ├─ maxRetries?: number
  ├─ execute(ctx)                   ├─ retryDelay?: number
  └─ onCleanup?(ctx)                ├─ pollInterval?: number
                                    │
                                    │ 内部实现（private）:
                                    ├─ generateHeader()
                                    ├─ sshUpload()
                                    ├─ sbatch()
                                    ├─ pollJob()
                                    └─ collectOutput()
```

---

## 2. 核心类型

### 2.1 `SlurmConfig` — 资源声明

```typescript
interface SlurmConfig {
  /** Slurm 队列/分区名 */
  partition: string;

  /** CPU 核数（--cpus-per-task） */
  cores: number;

  /** 计算节点数，默认 1 */
  nodes?: number;

  /** 内存，如 "100G"。不设则用队列默认 */
  memory?: string;

  /** 最大运行时间，如 "04:00:00"。不设则用队列默认 */
  walltime?: string;

  /** module load 列表，如 ["apps/apptainer/1.2.4"] */
  modules?: string[];

  /** 作业名覆盖，默认使用 CustomNode.name */
  jobName?: string;

  /** 额外 #SBATCH 指令（如 --gres=gpu:1），原样追加 */
  extraSBATCH?: string[];
}
```

**约束**: 引擎自动生成 `--ntasks=1` 和 `--cpus-per-task=${cores}`，`extraSBATCH` 中不应包含这两个参数。

### 2.2 `SshExecutor` — SSH 执行接口

```typescript
interface SshExecutor {
  /**
   * 在远端执行命令。
   * @param host    SSH config 别名（~/.ssh/config）
   * @param command 要执行的命令
   * @param opts    可选参数
   */
  exec(host: string, command: string, opts?: {
    /** 工作目录 */
    cwd?: string;
    /** 超时时间（ms），默认 30000 */
    timeout?: number;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

### 2.3 `BunSshExecutor` — 生产实现

```typescript
class BunSshExecutor implements SshExecutor {
  async exec(host: string, command: string, opts?: {
    cwd?: string;
    timeout?: number;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(
      ["/usr/bin/ssh", "-o", "BatchMode=yes", host, command],
      {
        cwd: opts?.cwd,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const exitCode = await proc.exited;
    return {
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
      exitCode,
    };
  }
}
```

### 2.4 `SlurmNode` — Abstract Class

```typescript
abstract class SlurmNode implements CustomNode {
  // ── 继承自 CustomNode（子类必须实现） ──
  abstract name: string;
  abstract description: string;
  abstract inputs: Record<string, InputDef>;
  abstract produces: string[];

  // ── Slurm 特有（子类必须实现） ──
  abstract slurmConfig: SlurmConfig;

  // ── Slurm 特有（子类可选覆写） ──
  /** sacct 轮询间隔（ms），默认 15000 */
  pollInterval?: number = 15000;

  /** 最大重试次数，默认 0（不重试） */
  maxRetries?: number = 0;

  /** 重试基础延迟（ms），默认 30000 */
  retryDelay?: number = 30000;

  /** 重试退避策略，默认 "fixed" */
  retryBackoff?: "fixed" | "exponential" = "fixed";

  // ── 子类唯一需要实现的方法 ──

  /**
   * 根据上下文生成 bash 命令体（不含 #SBATCH header）。
   * 引擎会拼接 header + 此方法的返回值生成完整 .slurm 文件。
   */
  abstract buildScript(ctx: ExecuteContext): string;

  /**
   * sbatch 提交前在远端执行的清理命令（可选）。
   * 不计入 Slurm 资源配额，在登录节点执行。
   */
  preCleanup?(ctx: ExecuteContext): string;

  // ── 依赖注入（测试用） ──

  /** SSH 执行器，默认使用 BunSshExecutor，测试可注入 fake */
  protected sshExecutor: SshExecutor = new BunSshExecutor();

  // ── 生命周期钩子（继承自 CustomNode） ──

  /**
   * ★ 引擎实现。用户不应覆写。
   *
   * 完整流程:
   *   1. preCleanup（如果有）
   *   2. buildScript → generateHeader → 拼接 .slurm
   *   3. SSH 上传 .slurm
   *   4. sbatch 提交 → 获 Job ID
   *   5. sacct 轮询
   *   6. 收集输出
   *   7. fail → retry（如果有）
   */
  async execute(ctx: ExecuteContext): Promise<NodeOutput>;

  async onCleanup?(ctx: ExecuteContext, result: NodeOutput | null, error: Error | null): Promise<void>;

  // ── 内部方法（private，子类不可见） ──

  private generateHeader(ctx: ExecuteContext): string;
  private sshUpload(ctx: ExecuteContext, script: string, remotePath: string): Promise<void>;
  private sbatch(ctx: ExecuteContext, remotePath: string): Promise<string>;
  private pollJob(ctx: ExecuteContext, jobId: string): Promise<JobResult>;
  private collectOutput(ctx: ExecuteContext, result: JobResult): Promise<NodeOutput>;
  private computeRetryDelay(attempt: number): number;
}

/** sacct 轮询结果 */
interface JobResult {
  jobId: string;
  state: "COMPLETED" | "FAILED" | "TIMEOUT" | "NODE_FAIL" | "OUT_OF_MEMORY" | "CANCELLED";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
```

---

## 3. 执行流程

### 3.1 `execute()` 完整生命周期

```
SlurmNode.execute(ctx)
  │
  ├─ 1. preCleanup（如果有）
  │     const cleanupCmd = this.preCleanup?.(ctx);
  │     if (cleanupCmd) await sshExecutor.exec(host, cleanupCmd);
  │     cleanup 失败 → console.warn，不阻塞主流程
  │
  ├─ 2. 生成 .slurm 脚本
  │     const userScript = this.buildScript(ctx);
  │     const header = this.generateHeader(ctx);
  │     const slurmScript = header + "\n\nset -euo pipefail\n" + userScript;
  │
  ├─ 3. SSH 上传
  │     const remotePath = `${ctx.workDir}/.slurm/${ctx.runId}_${ctx.nodeId}.slurm`;
  │     await sshExecutor.exec(host, `mkdir -p ${ctx.workDir}/.slurm`);
  │     await sshExecutor.exec(host, `cat > ${remotePath}`, { stdin: slurmScript });
  │
  ├─ 4. sbatch 提交
  │     const { stdout } = await sshExecutor.exec(host, `sbatch ${remotePath}`);
  │     // 解析 "Submitted batch job 58616438" → jobId
  │     const jobId = parseJobId(stdout);
  │     发射 "node.subjob_started" 事件（含 jobId）
  │
  ├─ 5. sacct 轮询（带重试）
  │     let attempt = 0;
  │     while (true) {
  │       const result = await this.pollJob(ctx, jobId);
  │       if (result.state === "COMPLETED") break;
  │       if (result.state === "CANCELLED") throw new WorkflowError(...);
  │       if (isTerminalFailure(result.state)) {
  │         if (attempt < this.maxRetries) {
  │           attempt++;
  │           await sleep(this.computeRetryDelay(attempt));
  │           jobId = await this.sbatch(ctx, remotePath); // 重新提交
  │           continue;
  │         }
  │         throw new WorkflowError(...);
  │       }
  │       await sleep(this.pollInterval);
  │     }
  │
  ├─ 6. 收集输出
  │     const output = await this.collectOutput(ctx, result);
  │     发射 "node.subjob_completed" 事件
  │
  └─ 7. 返回 NodeOutput
```

### 3.2 `generateHeader()` 输出格式

```bash
#!/bin/bash
#SBATCH --job-name=trim_galore
#SBATCH --partition=xahcnormal
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=100G
#SBATCH --time=04:00:00
#SBATCH --output={workDir}/.slurm/trim_galore_%j.out
#SBATCH --error={workDir}/.slurm/trim_galore_%j.err
#SBATCH --gres=gpu:1
```

`{workDir}` 为 `ctx.workDir`（来自 `params.work_dir`），引擎在调用 `generateHeader(ctx)` 时注入。

**关键约束**:
- `--ntasks=1` 和 `--cpus-per-task=N` 固定，禁止 `-n N`
- `--output` / `--error` 统一指向 stdout/stderr（通过 sacct 读取）
- `extraSBATCH` 追加在末尾，不参与模板求值

### 3.3 `pollJob()` 实现

```typescript
private async pollJob(ctx: ExecuteContext, jobId: string): Promise<JobResult> {
  const cmd = `sacct -j ${jobId} --format=JobID,State,ExitCode --noheader --parsable2`;
  const { stdout } = await this.sshExecutor.exec(host, cmd);

  const lines = stdout.trim().split("\n").filter(l => l);
  // sacct 返回多行：第一行是主作业，后续是 job steps
  const mainJob = lines[0];
  const [, state, exitCode] = mainJob.split("|");

  // 映射 Slurm 状态到统一枚举
  const mappedState = mapSlurmState(state, exitCode);

  // 收集 stdout/stderr
  const outputPath = `${ctx.workDir}/.slurm/${slurmConfig.jobName ?? this.name}_${jobId}`;
  const stdout = await this.sshExecutor.exec(host, `cat ${outputPath}.out`);
  const stderr = await this.sshExecutor.exec(host, `cat ${outputPath}.err`);

  return { jobId, state: mappedState, exitCode: parseInt(exitCode) || null,
           stdout: stdout.stdout, stderr: stderr.stdout };

  return { jobId, state: mappedState, exitCode: parseInt(exitCode) || null, stdout, stderr };
}
```

**Slurm 状态映射**:

| sacct State | SlurmNode JobResult.state | 后续动作 |
|-------------|--------------------------|---------|
| PENDING | — | 继续轮询 |
| RUNNING | — | 继续轮询 |
| COMPLETED (exit 0) | COMPLETED | 收集输出，成功 |
| COMPLETED (exit ≠ 0) | FAILED | 按重试策略处理 |
| TIMEOUT | TIMEOUT | 按重试策略处理 |
| NODE_FAIL | NODE_FAIL | 按重试策略处理 |
| OUT_OF_MEMORY | OUT_OF_MEMORY | 不重试，直接失败 |
| CANCELLED | CANCELLED | 抛异常 |

### 3.4 重试退避计算

```typescript
private computeRetryDelay(attempt: number): number {
  if (this.retryBackoff === "exponential") {
    return this.retryDelay * Math.pow(2, attempt - 1);
  }
  return this.retryDelay; // "fixed"
}
```

默认 `maxRetries: 0`，即不重试。

---

## 4. SSH 策略

### 4.1 连接信息来源

连接信息通过 `ctx.params` 注入，不硬编码在工具类中：

```yaml
# YAML 示例
params:
  cluster_host: "shuguang"
  cluster_port: 65082
  cluster_user: "liwei_agent"
```

工具通过 `ctx.params.cluster_host` 获取 host 别名，密钥通过 `ctx.secrets.SSH_KEY_DIR` + `~/.ssh/config` 管理。

### 4.2 SSH Config 约定

用户需在服务运行环境维护 `~/.ssh/config`：

```
Host shuguang
  HostName eshell111.hpccube.com
  Port 65082
  User liwei_agent
  IdentityFile ${SSH_KEY_DIR}/shuguang_key
```

引擎通过 `Bun.spawn("ssh", ["-o", "BatchMode=yes", host, command])` 使用别名，**不暴露密钥内容**给引擎或工具代码。

### 4.3 SSH 执行安全约束

| 规则 | 说明 |
|------|------|
| `BatchMode=yes` | 禁止交互式提示，密钥缺失立即失败 |
| 命令通过 argv 传递 | 不用 shell 拼接，避免注入 |
| 超时上限 | 单次 SSH 命令默认 30s，sbatch/sacct 可调至 60s |
| 重试不针对 SSH 错误 | SSH 连接失败直接抛异常，不走 Slurm 重试逻辑 |

---

## 5. 与 CustomNode 的关系

### 5.1 接口兼容性

`SlurmNode` implements `CustomNode`，因此可以注册到 `CustomNodeRegistry`：

```typescript
// 服务启动时
const registry = await CustomNodeRegistry.discover("./tools/");
// tools/ 下的 TrimGaloreNode extends SlurmNode extends CustomNode
// → registry 中的每个工具都是 CustomNode 实例
```

`CustomNodeExecutor` 不用知道它调用的是 `SlurmNode` 还是普通 `CustomNode`——统一走 `execute(ctx)`。

### 5.2 执行路径对比

| 阶段 | 普通 CustomNode | SlurmNode |
|------|----------------|-----------|
| Zod 校验 | 引擎执行 | 引擎执行 |
| inputs 求值 | 引擎执行 | 引擎执行 |
| execute() | 工具自己实现 | `SlurmNode` 封装（ssh + sbatch + sacct） |
| onCleanup() | 工具自己实现 | 工具可选实现 |
| 错误处理 | 抛异常 → FAILED | 抛异常 → FAILED（含重试） |

---

## 6. 测试策略

### 6.1 单元测试（Fake SSH）

通过注入 `FakeSshExecutor` 模拟 SSH 交互：

```typescript
class FakeSshExecutor implements SshExecutor {
  private responses: Map<string, { stdout: string; stderr: string; exitCode: number }> = new Map();

  /** 预设命令响应 */
  mockCommand(pattern: RegExp, response: { stdout: string; stderr: string; exitCode: number }): void;

  async exec(host: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    for (const [pattern, response] of this.responses) {
      if (pattern.test(command)) return response;
    }
    throw new Error(`Unmocked command: ${command}`);
  }
}
```

### 6.2 测试覆盖点

| 测试对象 | 覆盖点 |
|---------|--------|
| `SlurmNode` execute 正常流程 | preCleanup → buildScript → sbatch 解析 → pollJob → collectOutput |
| `SlurmNode` preCleanup 失败 | console.warn 记录，不阻塞主流程 |
| `SlurmNode` sbatch 解析失败 | stdout 不含 "Submitted batch job" → 抛异常 |
| `SlurmNode` sacct 状态映射 | PENDING→继续 / COMPLETED→完成 / TIMEOUT→重试 / OOM→直接失败 |
| `SlurmNode` 重试逻辑 | maxRetries=2 → 第一次失败重试 → 第二次失败重试 → 第三次失败抛异常 |
| `SlurmNode` 退避计算 | fixed 模式 / exponential 模式 |
| `generateHeader()` | 输出格式验证（含 --ntasks=1、modules、extraSBATCH） |
| `onCleanup()` 调用顺序 | execute 成功 → onCleanup 调 / execute 失败 → onCleanup 仍调 |

### 6.3 集成测试

需要真实 Slurm 集群（如曙光测试环境）。覆盖：

| 场景 | 验证点 |
|------|--------|
| 最小 Slurm 作业（`echo ok`） | 完整 sbatch → sacct 轮询 → 输出收集 |
| foreach + Slurm 作业 | N 子任务各自独立提交、并行轮询、输出独立收集 |
| 作业超时 | `--time=00:00:01` → TIMEOUT 状态 → 重试 |
| 作业 OOM | `--mem=1M` → OOM 状态 → 不重试直接失败 |

---

## 7. 文件结构

```
packages/workflow-engine/src/plugins/
├── types.ts              # CustomNode, InputDef, ExecuteContext（Design 1）
├── registry.ts           # CustomNodeRegistry（Design 1）
├── custom-executor.ts    # CustomNodeExecutor（Design 1）
├── slurm-node.ts         # SlurmNode, SlurmConfig, SshExecutor, BunSshExecutor（Design 2）
└── __tests__/
    ├── slurm-node.test.ts
    └── fake-ssh-executor.ts
```

---

## 8. 设计决策

| # | 决策 | 选择 | 原因 |
|---|------|------|------|
| D1 | slurmConfig 求值 | MVP 静态，P1 支持模板 | 20-30 样本无需动态资源 |
| D2 | SSH 连接信息 | 通过 `params` 扁平注入 | 解耦工具和集群 |
| D3 | SSH 密钥 | `~/.ssh/config` 别名，不暴露给引擎 | 安全隔离 |
| D4 | sacct 轮询 | 固定 15s 间隔，可配置 | 40 作业规模无压力 |
| D5 | #SBATCH header | SlurmNode 全权生成，`extraSBATCH` 扩展 | 保证 `--ntasks=1 --cpus-per-task=N` |
| D6 | SlurmNode 内部方法 | 全部 `private`，只暴露 `buildScript` + `preCleanup` | 接口最小化 |
| D7 | 重试策略 | 统一 `maxRetries`+`retryDelay`+`retryBackoff`，默认 0 | MVP 少重试，失败交给人 |
| D8 | preCleanup | 独立钩子，sbatch 前在远端执行 | 不计入 Slurm 资源配额 |
| D9 | SSH mock | 依赖注入 `SshExecutor` 接口 | 测试无需真实集群 |
| D10 | 执行器继承 | `SlurmNode implements CustomNode` | 对 CustomNodeExecutor 透明 |
