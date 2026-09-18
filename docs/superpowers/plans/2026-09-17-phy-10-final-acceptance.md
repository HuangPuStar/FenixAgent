# PHY-10 最终收口与统一验收实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 CE 阶段 1 的路径与交付收口，使全仓门禁、生产镜像、空库、现有数据库和关键 API/浏览器 E2E 全部得到可复核的通过证据。

**架构：** 保持现有业务合同不变，只修复迁移后的路径、测试扫描、依赖环、质量告警和生产交付接线。验收分为空 PostgreSQL 与现有 PostgreSQL 两条运行链路；现有库先备份并记录 schema 指纹，E2E 数据用独立前缀创建并通过业务入口清理。

**技术栈：** Bun 1.3、TypeScript、Elysia、React/Vite、Drizzle/PostgreSQL 16、Biome、dependency-cruiser、Docker/Compose、agent-browser。

---

## 文件结构与职责

### 创建

- `packages/resources/machine/src/server/repositories/registry-event.ts`：只负责写入 `registry_event`，解除 registry 生命周期服务与 file-WS 事件服务之间的依赖环。
- `docs/design/ce-ee-refactoring/review/phy-10-review.md`：未提交的范围、失败分类、删除测试、修复轮次和 review 证据。
- `docs/design/ce-ee-refactoring/review/e2e.md`：未提交的命令、版本、数据库、Docker、API、浏览器和清理证据。

### 修改

- `packages/resources/machine/src/server/services/registry.ts`：从独立 repository 导入事件写入函数，保留机器删除与 file-WS 清理顺序。
- `packages/resources/machine/src/server/services/file-machine-events.ts`：从独立 repository 导入事件写入函数，不再依赖 registry 服务。
- `scripts/ci.ts`：以独立步骤覆盖 server、scripts、全部 packages 和 apps/web 测试。
- `.github/workflows/ci.yml`：与本地最终测试入口保持一致，覆盖 scripts 与迁移后的 package/web 测试。
- `Dockerfile`：在依赖阶段纳入 apps workspace manifest，构建阶段复制完整 server app，继续输出 `dist/index.js` 与 `apps/web/dist`。
- `scripts/__tests__/app-entry-paths.test.ts`：静态守护 Docker、CI、Drizzle、Vite 和生产静态目录均指向 apps 下真实入口。
- 下列 53 个文件：仅清除 Biome 已报告的无效 suppression、无用 import、类型 import、无用 `undefined` 和同类零行为差异 warning：
  - `apps/server/src/test-utils/agent-config-route-deps.ts`
  - `apps/server/src/test-utils/setup-mocks.ts`
  - `apps/web/components/ui/pagination.tsx`
  - `apps/web/components/ui/tree.tsx`
  - `apps/web/src/hooks/use-task-views.ts`
  - `apps/web/src/lib/config-events.ts`
  - `apps/web/src/pages/agent-panel/ArtifactsPanel.tsx`
  - `packages/agent-runtime/web/__tests__/question-panel.test.tsx`
  - `packages/agent-runtime/web/components/chat/MessageBubble.tsx`
  - `packages/agent-runtime/web/components/chat/SubAgentPanel.tsx`
  - `packages/agent-runtime/web/hooks/use-chat-state.ts`
  - `packages/agent-runtime/web/hooks/use-session-state.ts`
  - `packages/platform/access-control/src/__tests__/resource-permission-service.test.ts`
  - `packages/resources/agent-config/src/server/routes/config-route-deps.ts`
  - `packages/resources/agent-config/src/server/routes/web/agent-sites.ts`
  - `packages/resources/agent-config/src/server/routes/web/config/agent-route-support.ts`
  - `packages/resources/agent-config/src/services/meta-agent.ts`
  - `packages/resources/agent-config/web/__tests__/config-agents-page.test.ts`
  - `packages/resources/agent-config/web/components/agent-panel/AgentSitesCard.tsx`
  - `packages/resources/agent-config/web/components/agent-panel/SiteFrame.tsx`
  - `packages/resources/agent-config/web/pages/agent-panel/pages/agent-sites-catalog.tsx`
  - `packages/resources/channel/src/__tests__/channel-provider.test.ts`
  - `packages/resources/channel/src/__tests__/hermes-client.test.ts`
  - `packages/resources/channel/web/pages/agent-panel/pages/AgentChannelsPage.tsx`
  - `packages/resources/identity-admin/web/src/__tests__/token-stats.test.ts`
  - `packages/resources/knowledge/web/components/knowledge/ResourcePreviewContent.tsx`
  - `packages/resources/knowledge/web/src/pages/agent-panel/components/ChunkDetailSheet.tsx`
  - `packages/resources/knowledge/web/src/pages/agent-panel/components/RetrievalTestPanel.tsx`
  - `packages/resources/machine/src/server/__tests__/file-ws-events.test.ts`
  - `packages/resources/machine/src/server/__tests__/fs-download-zip.test.ts`
  - `packages/resources/machine/web/src/__tests__/file-picker-dialog.test.tsx`
  - `packages/resources/mcp/web/__tests__/config-mcp-api-client.test.ts`
  - `packages/resources/mcp/web/pages/agent-panel/pages/agent-mcp-dialog.tsx`
  - `packages/resources/memory/web/pages/hindsight/components/Constellation.tsx`
  - `packages/resources/memory/web/pages/hindsight/components/DataView.tsx`
  - `packages/resources/model-management/src/__tests__/model-gateway-provider-service.test.ts`
  - `packages/resources/prod-view/web/__tests__/prod-view-instance-flow.test.ts`
  - `packages/resources/prod-view/web/pages/agent-panel/ProdViewsPanel.tsx`
  - `packages/resources/prod-view/web/pages/agent-panel/pages/AgentProdViewsPage.tsx`
  - `packages/resources/skill/src/__tests__/skill-archive-lifecycle.test.ts`
  - `packages/resources/skill/src/__tests__/skill-import-name-overwrite.test.ts`
  - `packages/resources/skill/src/__tests__/skill-import-parallel-deletes.test.ts`
  - `packages/resources/skill/src/__tests__/skill-import-shared-validation.test.ts`
  - `packages/resources/skill/web/pages/agent-panel/pages/agent-skills-catalog.tsx`
  - `packages/resources/task/web/pages/agent-panel/TasksPanel.tsx`
  - `packages/resources/task/web/pages/agent-panel/pages/AgentTasksPage.tsx`
  - `packages/resources/workflow/web/__tests__/workflow-yaml-utils-pure.test.ts`
  - `packages/resources/workflow/web/pages/workflow/WorkflowRuns.tsx`
  - `packages/resources/workflow/web/pages/workflow/WorkflowVersions.tsx`
  - `packages/resources/workflow/web/pages/workflow/components/InputsEditor.tsx`
  - `packages/resources/workflow/web/pages/workflow/components/ParamsEditor.tsx`
  - `packages/resources/workflow/web/pages/workflow/components/SkeletonRows.tsx`
  - `packages/resources/workflow/web/pages/workflow/hooks/useWorkflowPersistence.ts`

### 删除

下列 20 个旧测试已经在独立运行中证实依赖全局 preload/mock、共享 DOM stub 或旧模块替身，失败不代表生产实现。按已批准的 PHY-10 规则删除并在 review 中记录替代覆盖：

- `packages/orchestration/agent-node/agent-node-service.test.ts`
- `packages/orchestration/instance/instance.test.ts`
- `packages/orchestration/agent-controller/agent-controller.test.ts`
- `packages/resources/mcp/web/__tests__/config-mcp-routing.test.ts`
- `packages/resources/knowledge/web/__tests__/resource-preview-content-ssr.test.tsx`
- `packages/resources/knowledge/web/__tests__/agent-panel-knowledge-pure-conversions.test.tsx`
- `packages/resources/knowledge/web/__tests__/resource-preview-and-data-table-pure.test.ts`
- `packages/resources/knowledge/web/__tests__/resource-preview-data-table-exported-helpers.test.ts`
- `packages/resources/knowledge/web/__tests__/knowledge-graph-panel.test.ts`
- `packages/resources/knowledge/web/__tests__/resource-preview-round55-pure.test.ts`
- `packages/resources/identity-admin/src/__tests__/web-api-keys-routes.test.ts`
- `packages/resources/identity-admin/src/__tests__/web-organizations-routes.test.ts`
- `packages/resources/identity-admin/src/__tests__/round55-organizations-routes.test.ts`
- `packages/resources/memory/web/__tests__/memories-page.test.tsx`
- `packages/resources/agent-config/src/__tests__/api-agents-apikey-regression.test.ts`
- `packages/resources/agent-config/src/__tests__/config-agent-resource-access.test.ts`
- `packages/resources/prod-view/src/__tests__/prod-view-service.test.ts`
- `packages/resources/model-management/src/__tests__/model-gateway-admin-ui-route.test.ts`
- `packages/resources/machine/src/server/__tests__/file-events-endpoint.test.ts`
- `apps/web/src/__tests__/card-renderer-pure-utils.test.ts`

## 最终提交映射与实际文件边界

以下映射以 `git show --name-status <hash>` 为真相源；`A`、`M`、`D` 分别表示新增、修改、删除：

| Task | 提交 | 归属 |
|------|------|------|
| Task 1 | 无空提交 | 只建立基线与未提交证据 |
| Task 2 | `ec8a728a0` | 解除 Machine registry 与 file-WS 事件依赖环 |
| Task 3 | `a1096215b` | 收口全仓测试矩阵并删除 20 个全局污染旧测试 |
| Task 4 | `3cdb93673` | 清理 53 个文件的 Biome warning |
| Task 5 | `ccc4703c4` | 修复生产镜像应用路径及静态守护 |
| Task 6 | 无空提交 | 只执行全量门禁与构建验证 |
| Task 7 | `ffdfa21e2` | 修复空库生产镜像启动顺序 |
| Task 8 | `5a5382910` | 隔离现有库验收期间的后台调度写入 |
| Task 9 | `fa8b06d43` | 修复现有库关键 API/页面验收边界 |
| Task 10 | `ab335a6b6` | 收口执行计划与 env 测试 fixture |

Task 2、3、7、8、9 的实际提交范围如下；验收阶段发现的最小修复归属对应验收任务，不归入 Task 10：

- **Task 2 / `ec8a728a0`**
  - `A packages/resources/machine/src/server/repositories/registry-event.ts`
  - `M packages/resources/machine/src/server/services/file-machine-events.ts`
  - `M packages/resources/machine/src/server/services/registry.ts`
  - `M packages/resources/machine/src/__tests__/registry-filews-cleanup.test.ts`
  - `M packages/resources/machine/src/__tests__/round39-registry-service.test.ts`
- **Task 3 / `a1096215b`**
  - `M .github/workflows/ci.yml`
  - `M apps/server/src/__tests__/architecture-check.test.ts`
  - `A scripts/__tests__/ci-output.test.ts`
  - `M scripts/__tests__/rmd-04-migration.test.ts`
  - `M scripts/__tests__/rmd-08-migration.test.ts`
  - `A scripts/ci-output.ts`
  - `M scripts/ci.ts`
  - `D`：上方“删除”小节列出的 20 个旧测试；该清单与此提交的删除路径逐项一致。
- **Task 7 / `ffdfa21e2`**：空库验收发现权限端口晚于模型网关装配，以及系统管理员凭据在首启、并发和失败重试中的安全边界问题；最小修复限定为关键启动编排、凭据安全发布及其测试。
  - `A apps/server/src/bootstrap/startup-sequence.ts`
  - `M apps/server/src/main.ts`
  - `M apps/server/src/__tests__/resource-permission-bootstrap-order.test.ts`
  - `M packages/resources/identity-admin/src/server/services/system-admin.ts`
  - `M packages/resources/identity-admin/src/__tests__/system-admin.test.ts`
- **Task 8 / `5a5382910`**：现有库验收发现后台 Scheduler 会改变只读指纹，最小修复增加显式启动边界与禁用配置，并同步部署样例和测试。
  - `M .env.example`
  - `M apps/server/src/__tests__/env-validation.test.ts`
  - `A apps/server/src/__tests__/scheduler-bootstrap.test.ts`
  - `A apps/server/src/bootstrap/scheduler-startup.ts`
  - `M apps/server/src/env.ts`
  - `M apps/server/src/main.ts`
  - `M docker-compose.yml`
  - `M docker/prod/.env.example`
  - `M docker/prod/docker-compose.yml`
- **Task 9 / `fa8b06d43`**：核心 API/页面验收发现 query 转发、Channel 文案、Hindsight 错误映射和 Skill 资源 ID 校验边界，最小修复及回归测试限定在以下文件。
  - `M apps/web/src/__tests__/request.test.ts`
  - `M apps/web/src/api/request.ts`
  - `A packages/resources/channel/web/__tests__/channel-i18n-contract.test.ts`
  - `M packages/resources/channel/web/i18n/en/channels.json`
  - `M packages/resources/channel/web/i18n/zh/channels.json`
  - `M packages/resources/channel/web/pages/agent-panel/pages/AgentChannelsPage.tsx`
  - `A packages/resources/memory/web/__tests__/hindsight-api-error.test.ts`
  - `M packages/resources/memory/web/api/hindsight.ts`
  - `A packages/resources/skill/src/__tests__/skill-resource-id-validation.test.ts`
  - `M packages/resources/skill/src/server/services/config/skill.ts`

随后若产生仅修正文档表述、路径或数字的复审更正提交，不改变上述任务代码归属，也不把既有实现移动到 Task 10。按用户最新决定，PHY-10 保留按任务近似提交历史；Task 1、6 仅产生证据或验证结果且不创建空提交。Task 10 不再合并重写既有提交，只提交本计划及必要的最终收口文件；review、`e2e.md` 与备份继续留在工作区且不提交。

## 任务 1：建立 PHY-10 基线和证据骨架

**文件：**
- 创建但不提交：`docs/design/ce-ee-refactoring/review/phy-10-review.md`
- 创建但不提交：`docs/design/ce-ee-refactoring/review/e2e.md`

- [x] **步骤 1：记录代码和工具基线**

运行：

```bash
git status --short --untracked-files=all
git rev-parse HEAD
git rev-parse da5eb543bf17aa0c772eebbf0961e4dc2daac0e8
bun --version
docker version --format '{{.Client.Version}}|{{.Server.Version}}'
docker compose version
```

预期：HEAD 包含已确认设计提交；Docker client/server 均可用；只存在用户已有的 review 未跟踪文件。

- [x] **步骤 2：记录已知失败而不修改文件**

运行：

```bash
bun run check:dependencies
bunx biome check --max-diagnostics=500 apps/server/src/ apps/ packages/ scripts/ docs/.vitepress/
bun test packages/
bun test apps/web/src/__tests__/
```

预期：依赖检查只报告 Machine file-WS 同一依赖环的 4 条路径；Biome 报告 104 warnings；package 测试报告 `6522 pass, 39 fail, 10 errors`；apps/web 报告 `954 pass, 1 fail`。将摘要写入 `phy-10-review.md`，不得复制敏感环境值。

- [x] **步骤 3：记录根路径与 schema/迁移基线**

运行：

```bash
test -z "$(rg --files src web 2>/dev/null)"
git show da5eb543bf17aa0c772eebbf0961e4dc2daac0e8:src/db/schema.ts | shasum -a 256
shasum -a 256 apps/server/src/db/schema.ts
git diff --exit-code da5eb543bf17aa0c772eebbf0961e4dc2daac0e8 -- drizzle ':!drizzle/README.md'
```

预期：根源码为空；两个 schema SHA-256 都是 `ea9537796052488aac42bd3be31535ea7137fc090a94a06e34911b4af479b6e4`；Drizzle SQL/meta/journal 无差异。

## 任务 2：解除 Machine file-WS 依赖环

**文件：**
- 创建：`packages/resources/machine/src/server/repositories/registry-event.ts`
- 修改：`packages/resources/machine/src/server/services/registry.ts`
- 修改：`packages/resources/machine/src/server/services/file-machine-events.ts`

- [x] **步骤 1：用依赖检查确认失败**

运行：`bun run check:dependencies`

预期：FAIL，环包含 `file-ws-requests → file-op-retry → file-machine-events → registry → file-ws-handler`。

- [x] **步骤 2：提取单一事件写入 repository**

在 `registry-event.ts` 写入完整实现：

```ts
import { db } from "@server/db";
import { registryEvent } from "@server/db/schema";

function generateRegistryEventId(): string {
  return `evt_${crypto.randomUUID().slice(0, 22)}`;
}

/** 写入一条机器 registry 事件，业务事件类型和详情由调用方定义。 */
export async function writeRegistryEvent(
  machineId: string,
  type: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(registryEvent).values({
    id: generateRegistryEventId(),
    machineId,
    type,
    detail,
  });
}
```

从 `registry.ts` 删除原函数体并改为从 `../repositories/registry-event` 导入；`file-machine-events.ts` 同样改为从 repository 导入。不得改变 `deleteMachine` 中“删除记录 → 关闭 file-WS → 尝试写 retired 事件”的现有顺序，也不得修改 fire-and-forget 错误处理。

- [x] **步骤 3：运行 Machine 专项测试**

运行：

```bash
bun test packages/resources/machine/src/server/__tests__/file-ws-handler.test.ts packages/resources/machine/src/server/__tests__/file-ws-events.test.ts packages/resources/machine/src/__tests__/registry-service.test.ts
```

预期：全部 PASS；连接替换、pending reject、事件告警和机器删除行为不变。

- [x] **步骤 4：确认依赖图归零**

运行：`bun run check:dependencies`

预期：`no dependency violations`，退出码 0。

## 任务 3：删除受全局 mock 污染的旧测试并收口扫描入口

**文件：**
- 删除：文件结构“删除”章节列出的 20 个测试文件
- 修改：`scripts/ci.ts`
- 修改：`.github/workflows/ci.yml`

- [x] **步骤 1：逐项确认删除集合仍表现为全局污染**

运行：

```bash
bun test \
  packages/orchestration/agent-node/agent-node-service.test.ts \
  packages/orchestration/instance/instance.test.ts \
  packages/orchestration/agent-controller/agent-controller.test.ts \
  packages/resources/mcp/web/__tests__/config-mcp-routing.test.ts \
  packages/resources/knowledge/web/__tests__/resource-preview-content-ssr.test.tsx \
  packages/resources/knowledge/web/__tests__/agent-panel-knowledge-pure-conversions.test.tsx \
  packages/resources/knowledge/web/__tests__/resource-preview-and-data-table-pure.test.ts \
  packages/resources/knowledge/web/__tests__/resource-preview-data-table-exported-helpers.test.ts \
  packages/resources/knowledge/web/__tests__/knowledge-graph-panel.test.ts \
  packages/resources/knowledge/web/__tests__/resource-preview-round55-pure.test.ts \
  packages/resources/identity-admin/src/__tests__/web-api-keys-routes.test.ts \
  packages/resources/identity-admin/src/__tests__/web-organizations-routes.test.ts \
  packages/resources/identity-admin/src/__tests__/round55-organizations-routes.test.ts \
  packages/resources/memory/web/__tests__/memories-page.test.tsx \
  packages/resources/agent-config/src/__tests__/api-agents-apikey-regression.test.ts \
  packages/resources/agent-config/src/__tests__/config-agent-resource-access.test.ts \
  packages/resources/prod-view/src/__tests__/prod-view-service.test.ts \
  packages/resources/model-management/src/__tests__/model-gateway-admin-ui-route.test.ts \
  packages/resources/machine/src/server/__tests__/file-events-endpoint.test.ts \
  apps/web/src/__tests__/card-renderer-pure-utils.test.ts
```

预期：出现缺失 mock export、跨文件 stub 覆盖或共享 DOM `matchMedia` 污染；这些错误不是生产请求或浏览器流程返回的业务错误。把文件、原覆盖目标、失败类型和后续重写要求写入 `phy-10-review.md`。

- [x] **步骤 2：删除 20 个旧测试文件**

使用补丁逐个删除文件结构所列文件。不得删除同目录其他通过的权限、租户隔离、迁移、并发或资源释放测试。

- [x] **步骤 3：让本地 precheck 覆盖全部迁移测试**

将 `scripts/ci.ts` 的测试步骤收敛为三个独立进程：

```ts
{
  name: "server-and-script-tests",
  cmd: "bun test apps/server/src/__tests__/ scripts/__tests__/ packages/platform/platform-sdk/src/__tests__/ 2>&1",
  filter: filterTestSummary,
},
{
  name: "package-tests",
  cmd: "bun test packages/ 2>&1",
  filter: filterTestSummary,
},
{
  name: "web-app-tests",
  cmd: "bun test apps/web/src/__tests__/ 2>&1",
  filter: filterTestSummary,
},
```

把当前重复的测试摘要过滤逻辑提取为文件内 `filterTestSummary(out: string): string | null`，保留失败用例详情和最终 pass/fail/skip/Ran 行。删除只覆盖五个资源目录的 `migrated-resource-tests` 步骤。

```ts
function filterTestSummary(out: string): string | null {
  const lines = out.split("\n");
  const summary = lines.filter((line) => /^\s*\d+ (pass|fail|skip)/.test(line) || /^Ran /.test(line));
  const failures: string[] = [];
  let collecting = false;

  for (const line of lines) {
    if (line.includes("(fail)") || line.includes("# Unhandled error between tests")) {
      collecting = true;
      failures.push(line.trim());
      continue;
    }
    if (collecting && line.trim() === "") {
      collecting = false;
      continue;
    }
    if (
      collecting &&
      (line.includes("error:") ||
        line.includes("SyntaxError:") ||
        line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith("at "))
    ) {
      failures.push(line);
    }
  }

  const output = [...failures, ...(failures.length ? [""] : []), ...summary];
  return output.length ? output.join("\n") : null;
}
```

- [x] **步骤 4：同步 GitHub CI 扫描范围**

在 `.github/workflows/ci.yml` 中使用与本地相同的三组测试入口：server + scripts + platform-sdk、`packages/`、`apps/web/src/__tests__/`。保留每组独立 Bun 进程，不使用单个跨域 mock 共享进程拼接所有路径。

- [x] **步骤 5：验证新测试矩阵**

运行：

```bash
bun test apps/server/src/__tests__/ scripts/__tests__/ packages/platform/platform-sdk/src/__tests__/
bun test packages/
bun test apps/web/src/__tests__/
```

预期：三条命令均 0 fail、0 errors；允许两个需要真实外部 runtime 的既有 integration 用例保持显式 skip。

## 任务 4：清零 Biome warning

**文件：**
- 修改：文件结构中列出的 53 个 warning 文件

- [x] **步骤 1：应用限定范围的安全修复**

运行：

```bash
bunx biome check --write --max-diagnostics=500 apps/server/src/ apps/ packages/ scripts/ docs/.vitepress/
```

预期：只产生格式、import、无效 suppression 与静态 lint 修复；不得接受改变业务分支、effect 依赖语义或数组 key 选择的 unsafe fix。

- [x] **步骤 2：人工处理剩余 warning**

`routeConfigDeps` 的动态 namespace 访问是测试 override Proxy 的必要边界；用精确 suppression 保留语义，并删除无用的 `undefined`：

```ts
export const routeConfigDeps = new Proxy({} as RouteConfigDeps, {
  get: (_target, property) => {
    if (typeof property !== "string") return;
    const key = property as keyof RouteConfigDeps;
    // biome-ignore lint/performance/noDynamicNamespaceImportAccess: Proxy 按现有服务名提供测试 override，生产仍返回同一 named export。
    return testOverrides?.[key] ?? configServices[key];
  },
});
```

对 React hook warning 删除已经失效且无实际 suppression 效果的注释；保留现有依赖数组和解释设计原因的普通注释。对 array-index key warning 只删除失效 suppression，不改现有 key，以避免渲染身份行为变化。

- [x] **步骤 3：审查机械修改没有越界**

运行：

```bash
git diff --stat
git diff -- apps/server/src apps/web packages scripts
```

预期：warning 文件只有类型导入、无用符号、无用 `undefined`、suppression/注释或等价显式映射变化；没有 API、状态机、权限或 UI 行为变更。

- [x] **步骤 4：验证 warning 为零**

运行：

```bash
bunx biome check --max-diagnostics=500 apps/server/src/ apps/ packages/ scripts/ docs/.vitepress/
bun run typecheck
bun run typecheck:web
```

预期：Biome `Found 0 warnings`、退出码 0；两项类型检查通过。

## 任务 5：守护生产交付路径

**文件：**
- 修改：`Dockerfile`
- 修改：`scripts/__tests__/app-entry-paths.test.ts`

- [x] **步骤 1：添加失败的静态交付测试**

在 `app-entry-paths.test.ts` 添加中文行为注释和断言：

```ts
// Docker 依赖与构建阶段必须包含 apps workspace，并只构建新的 server/web 入口。
test("Docker 构建复制 apps workspace 并输出新入口产物", async () => {
  const dockerfile = await Bun.file("Dockerfile").text();
  expect(dockerfile).toContain("COPY apps/server/package.json apps/server/package.json");
  expect(dockerfile).toContain("COPY apps/web/package.json apps/web/package.json");
  expect(dockerfile).toContain("COPY apps/server ./apps/server");
  expect(dockerfile).toContain("bun build apps/server/src/main.ts");
  expect(dockerfile).toContain("COPY --from=build /app/apps/web/dist ./apps/web/dist");
  expect(dockerfile).not.toMatch(/COPY (?:\.\/)?(?:src|web)\b/);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`bun test scripts/__tests__/app-entry-paths.test.ts`

预期：FAIL，当前 deps 阶段没有复制 apps manifests，server build 阶段只复制 `apps/server/src`。

- [x] **步骤 3：最小修改 Dockerfile**

在 deps 阶段 `bun install` 前增加：

```dockerfile
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
```

把 build 阶段的 `COPY apps/server/src ./apps/server/src` 改为：

```dockerfile
COPY apps/server ./apps/server
```

保留现有 migration build、启动命令、静态产物位置和 runtime 工具安装顺序。

- [x] **步骤 4：验证静态交付测试和旧路径搜索**

运行：

```bash
bun test scripts/__tests__/app-entry-paths.test.ts
rg -n --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!docs/**' --glob '!spec/**' --glob '!.claude/**' '(^|[^A-Za-z0-9_])(src|web)/' package.json bunfig.toml tsconfig.json tsconfig.base.json drizzle.config.ts Dockerfile docker-compose.yml docker scripts apps .github
```

预期：测试 PASS；搜索命中仅为 `apps/**/src`、package 自身 `src`、`@/src` 别名和注释，不存在指向根 `src/` 或根 `web/` 的运行引用。

## 任务 6：执行完整静态门禁与生产构建

**文件：**
- 修改：前述任务文件（仅针对失败根因）
- 更新但不提交：`docs/design/ce-ee-refactoring/review/phy-10-review.md`

- [x] **步骤 1：运行完整 precheck**

运行：`bun run precheck`

预期：format、import-sort、module-registry、architecture、server/web/app skeleton tsc、dependency-boundaries、lint、server/script、package 和 web-app tests 全部显示 `✓`，最终 `✓ All passed`。

- [x] **步骤 2：运行前端生产构建**

运行：`bun run build:web`

预期：Vite 构建成功，输出到 `apps/web/dist`，无 server-only Node 模块加载错误。

- [x] **步骤 3：运行 browser surface 专项守护**

运行：

```bash
bun test packages/chat-channel/src/__tests__/chat-channel-browser-surface.test.ts
```

预期：PASS，`@fenix/chat-channel` 浏览器根入口未导出 server-only 模块。

- [x] **步骤 4：若门禁失败，只修复已分类根因**

生产代码、路径、构建或依赖问题按失败文件最小修复；旧全局 mock/stub 测试只有符合规格中的五项删除条件时才能删除，并追加到 review 的删除表。每轮只重跑失败专项，归零后再重跑一次 `bun run precheck` 和 `bun run build:web`。

## 任务 7：构建镜像并验收隔离空库

**文件：**
- 更新但不提交：`docs/design/ce-ee-refactoring/review/e2e.md`

- [x] **步骤 1：构建 production 与 migration 镜像**

运行：

```bash
docker build --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" -t fenix:phy10 .
docker build --target migrate -t fenix-migrate:phy10 .
```

预期：两个镜像构建成功；server bundle 为 `/app/dist/index.js`，Web 产物为 `/app/apps/web/dist`，migration 入口为 `/app/migrate.js`。

- [x] **步骤 2：创建隔离网络、空库卷和 PostgreSQL**

运行：

```bash
docker network create phy10-empty-net
docker volume create phy10-empty-pgdata
docker run -d --name phy10-empty-postgres --network phy10-empty-net \
  --env-file "${PHY10_EMPTY_PG_ENV_FILE:?provide a mode-0600 PostgreSQL env file}" \
  -v phy10-empty-pgdata:/var/lib/postgresql/data postgres:16-alpine
docker exec phy10-empty-postgres sh -lc 'until pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 1; done'
```

预期：隔离 PostgreSQL healthy，不映射宿主 5432，不接触现有数据库。env-file 由执行环境安全派生，只含任务临时凭据，mode 为 `0600`，使用后删除且不记录内容。

- [x] **步骤 3：用 migration 镜像应用真实迁移链**

运行：

```bash
docker run --rm --network phy10-empty-net \
  --env-file "${PHY10_EMPTY_APP_ENV_FILE:?provide a mode-0600 app env file}" \
  fenix-migrate:phy10
```

预期：退出码 0；`drizzle.__drizzle_migrations` 包含完整历史链。

- [x] **步骤 4：启动生产 server 镜像**

运行：

```bash
docker run -d --name phy10-empty-rcs --network phy10-empty-net -p 13010:3000 \
  --env-file "${PHY10_EMPTY_APP_ENV_FILE:?provide a mode-0600 app env file}" \
  -e RCS_HOST=0.0.0.0 -e RCS_PORT=3000 \
  fenix:phy10 sh -lc 'bun migrate.js && exec bun --no-install run dist/index.js'
```

预期：`curl --fail http://127.0.0.1:13010/health` 成功；`/ctrl/` 返回生产 HTML/静态资源；日志显示 initDb、data migration、builtin、网关、Core、scheduler 按现有顺序启动且没有旧根文件缺失错误。

- [x] **步骤 5：执行空库最小登录与资源 E2E**

使用容器生成的 system-admin 密码文件进行登录，但不得把密码写入日志或证据。创建 `PHY10_EMPTY_<时间戳>` 临时组织，验证组织读取、Agent 配置创建与页面加载，然后经业务入口删除临时组织。

预期：认证 cookie、active organization、`/web/*` 响应解包和静态路由均正常。

- [x] **步骤 6：验证优雅停止并保留清理清单**

运行：

```bash
docker stop --time 30 phy10-empty-rcs
docker logs phy10-empty-rcs
```

预期：进程在 30 秒内退出；日志没有未处理异常，runtime、scheduler、连接池和 transport 执行现有释放流程。先把结果写入 `e2e.md`；最终验收完成后再删除精确命名的容器、网络和卷。

## 任务 8：备份并直接验收现有数据库

**文件：**
- 更新但不提交：`docs/design/ce-ee-refactoring/review/e2e.md`
- 创建但不提交：`data/backups/phy10-<timestamp>.dump`

- [x] **步骤 1：只读记录现有数据库基线**

现有数据库容器为 `fenixagent-postgres-1`，网络为 `fenixagent_default`。运行：

```bash
docker exec fenixagent-postgres-1 psql -U rcs -d rcs -Atc 'select version();'
docker exec fenixagent-postgres-1 psql -U rcs -d rcs -Atc 'select count(*) from drizzle.__drizzle_migrations;'
docker exec fenixagent-postgres-1 pg_dump -U rcs -d rcs --schema-only --no-owner --no-privileges | shasum -a 256
```

预期：全部只读命令成功。证据只记录版本、迁移数量和 hash，不记录连接串或业务内容。

- [x] **步骤 2：创建不可覆盖的本地备份**

运行时生成一次 UTC 时间戳并使用显式路径：

```bash
mkdir -p data/backups
docker exec fenixagent-postgres-1 pg_dump -U rcs -d rcs -Fc > "data/backups/phy10-$(date -u +%Y%m%dT%H%M%SZ).dump"
test -s "$(ls -t data/backups/phy10-*.dump | head -1)"
```

预期：备份命令退出 0，最新文件非空。只在 `e2e.md` 记录路径、大小和 SHA-256，不提交 dump。

- [x] **步骤 3：当前镜像直接连接现有 DB**

运行：

```bash
docker run -d --name phy10-existing-rcs --network fenixagent_default -p 13011:3000 \
  --env-file "${PHY10_EXISTING_APP_ENV_FILE:?provide a mode-0600 derived env file}" \
  -e RCS_HOST=0.0.0.0 -e RCS_PORT=3000 -e RCS_DISABLE_SCHEDULER=true \
  fenix:phy10 sh -lc 'bun migrate.js && exec bun --no-install run dist/index.js'
```

预期：`curl --fail http://127.0.0.1:13011/health` 成功；迁移报告无新 DDL；历史组织、Agent、Provider/Model 等列表可读取。派生 env-file 从现有容器配置安全生成，mode 为 `0600`，不得输出或持久化其中的连接串、key 或其他敏感值。

- [x] **步骤 4：确认启动前后 schema 指纹一致**

重复步骤 1 的 schema-only dump hash。

预期：hash 与启动前完全一致。若不同，立即停止后续写入，保留容器日志和差异，等待用户决定；不得自动恢复备份。

## 任务 9：执行现有 DB 的 API 与浏览器关键流程

**文件：**
- 更新但不提交：`docs/design/ce-ee-refactoring/review/e2e.md`

- [x] **步骤 1：建立隔离测试身份与组织**

通过 `http://127.0.0.1:13011/ctrl/login` 注册或使用 system-admin 创建唯一 `PHY10_<时间戳>` 测试用户和组织。记录临时对象 ID，不记录密码、cookie 或 token。

预期：登录成功；active organization header/cookie 生效；测试用户不能读取其他组织私有资源。

- [x] **步骤 2：执行核心 API smoke**

使用浏览器会话或同一 cookie jar 验证：

```text
GET  /health
GET  /web/organizations
GET  /web/config/agents
GET  /web/config/providers
GET  /web/config/models
GET  /web/config/skills
GET  /web/config/mcp
GET  /web/knowledgeBases
GET  /web/registry/machines?page=1&pageSize=20
GET  /web/tasks/v2?page=1&pageSize=20
GET  /web/channels/providers
GET  /web/channels/hermes/status
GET  /web/channels/bindings
```

预期：所有路径保持原 method、认证与 `{ success, data }` 合同；未配置外部依赖的接口返回既有明确错误，不出现 404 路由丢失或模块加载异常。

- [x] **步骤 3：用 agent-browser 执行关键页面 E2E**

依次访问并记录截图或页面状态：登录/组织、Agent 编辑与启动/Chat、Provider/Model、Skill/MCP/Knowledge、Machine/Sandbox/file、Workflow/Task、Site、Observer/系统管理。

在临时组织中创建最小 Agent、最小 Workflow 和禁用状态 Task；能连接现有 Agent/Machine/模型网关时执行真实成功路径。外部依赖不可用时验证 loading 结束、错误可见、重试可用、无页面崩溃，并记录缺失前置条件。

终态例外：本步骤已完成自动化可执行范围和失败态验收。用户批准将 Agent/Chat + Sandbox、file-WS、Agent Site、RAGFlow Knowledge、Hindsight Memory 五类外部成功链转为人工验收；`[x]` 表示自动范围已执行并记录，不表示这五类成功链已自动完成。人工步骤、成功标准和清理要求以 `e2e.md` 为准。

- [x] **步骤 4：验证失败、权限与隔离路径**

使用临时普通用户请求另一个组织的资源 ID，预期 403 或 404；提交非法 workspace 路径，预期词法校验拒绝；未连接 file-WS 时预期明确服务不可用而非本地回退；Agent/Chat 外部运行不可用时预期错误和资源释放完成。

- [x] **步骤 5：通过业务入口清理临时数据**

按依赖逆序删除 Task、Workflow、Skill/MCP/Knowledge、Agent/Environment、Machine/Sandbox 投影和临时组织/用户。随后重新查询确认对象不可达。

预期：清理成功；既有对象数量和 schema 指纹没有非预期变化。无法删除的对象必须停止收口、记录 ID 和原因并反馈，不能直接 SQL 删除。

## 任务 10：最终 review、全量复测与提交收口

**文件：**
- 已按任务提交：本计划涉及的代码和配置
- 不提交：`docs/design/ce-ee-refactoring/review/phy-10-review.md`
- 不提交：`docs/design/ce-ee-refactoring/review/e2e.md`
- 最终提交：`docs/superpowers/plans/2026-09-17-phy-10-final-acceptance.md` 及必要的最终收口文件

- [x] **步骤 1：执行规格 review**

逐项对照 `docs/design/ce-ee-refactoring/ce-ee-refactoring-stage-1-plan.md` 第 5 节和设计规格，确认目录、静态测试、前后端产物、数据库、合同/权限与端到端证据齐全。把发现写入 `phy-10-review.md`，修复所有必须修复项后重新 review，直到为零。

- [x] **步骤 2：执行代码质量 review**

检查完整 `git diff da5eb543..HEAD` 的最终收口部分及当前工作树，重点确认无业务行为扩张、无 schema/迁移变化、无敏感信息、无重复实现、删除测试均有替代证据。运行：

```bash
git diff --check
git diff --name-status
git status --short --untracked-files=all
```

预期：无空白错误；review/e2e 与既有 review 文件保持未跟踪；没有 dump、密码或 `.env` 被暂存。

- [x] **步骤 3：最终统一复测**

先在最终代码稳定、Docker runtime 仍存在时依次完成静态门禁、最终镜像构建、空库/现有库 HTTP 验收，以及现有库 runtime 启动前后只读指纹比较：

```bash
test -z "$(rg --files src web 2>/dev/null)"
bun run precheck
bun run build:web
bun test packages/chat-channel/src/__tests__/chat-channel-browser-surface.test.ts
bun run docs:build
```

HTTP、真实 asset 与数据库前后比较结果先写入 `e2e.md`，再执行步骤 4 清理。清理后只做最终镜像 inspect、现有 PostgreSQL 状态和只读指纹核验，不再访问已删除的 13011 runtime：

```bash
docker image inspect fenix:phy10 fenix-migrate:phy10 >/dev/null
docker inspect fenixagent-postgres-1 --format '{{.State.Status}}|{{.State.Health.Status}}'
docker exec fenixagent-postgres-1 sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema-only --no-owner --no-privileges' \
  | sed '/^\\restrict /d;/^\\unrestrict /d' | shasum -a 256
```

预期：静态门禁全部退出 0，precheck 无 warning/error；最终镜像可 inspect，现有 PostgreSQL 保持 running/healthy。代码 schema 与 Drizzle SQL/meta/journal 相对 `da5eb543bf17aa0c772eebbf0961e4dc2daac0e8` 必须零差异。现有 DB 因用户授权恢复 `agent_config.model`，允许其 schema hash 不同于任务 8 的恢复前 hash；但最终 runtime 启动前后使用同一规范化算法得到的 hash 必须完全一致，迁移、八表、Scheduler 与 execution 指纹也必须一致。

- [x] **步骤 4：清理精确命名的临时运行资源**

确认 `e2e.md` 已记录证据后运行：

```bash
docker rm -v phy10-final-empty-rcs
docker rm -v phy10-empty-rcs
docker rm -v phy10-existing-rcs-task8
docker stop --time 30 phy10-existing-rcs
docker rm -v phy10-existing-rcs
# 若最终现有库验收使用了另一个精确命名的临时 app，同样先 stop，再按精确名称 rm -v。
docker stop --time 30 phy10-empty-postgres
docker rm phy10-empty-postgres
docker network rm phy10-empty-net
docker volume rm phy10-empty-pgdata
```

必须逐一确认以下 7 个任务匿名卷不存在：

- 空库：`b6127624fa1c6cd4d249ec5fb9419489b152694f4852890595664a154707edf7`、`afc1faa6653415c7ec29664b93d17d4620e37674a8d6e989da3f075ca07a43db`、`6cbdea53c08454e8e9e04dba3e9db5d1c2b4cdc202a4d5870fb491eb6d771c84`、`1e43958259c8fc78a99b2af619139d866c9330f11b6ad3952bf7cd682e3cf759`、`f7eb23f7a922b2ea20cccb28bfe58de450f767c3a8472c2edd50cd3d11ccf9e4`。
- 现有库 app：`30046aa03230d23b8b85848be3ded888b07d8a99e68cbb04c604a274ce5d65b2`、`3bbeaa7c3ee4e42c977cb05b1cf84831b40082370acdf32461f823d680edc603`。

预期：只删除 PHY-10 创建的显式命名资源。按上列完整 ID 逐一 inspect；容器引用归零后若 `rm -v` 未自动删除，只按完整 ID 精确 `docker volume rm`，最终 7 个匿名卷全部不存在且不可恢复。`fenixagent-postgres-1`、`fenixagent_default` 与 `fenixagent_postgres-data` 禁止停止或删除；备份保留供用户决定后续清理。

- [x] **步骤 5：收口按任务提交记录**

确认任务 2、3、4、5、7、8、9 的提交 ID 与任务归属；任务 1、6 不创建空提交。最终只暂存本计划及必要的最终收口文件，显式排除 `docs/design/ce-ee-refactoring/review/`、`data/backups/`、`.env` 与运行日志。计划文件受 ignore 规则影响，由主代理使用 `git add -f`；执行代理不得自行提交或暂存。

```bash
git add -f docs/superpowers/plans/2026-09-17-phy-10-final-acceptance.md
git diff --cached --check
git diff --cached --name-status
```

预期：保留按任务拆分的实现历史，最终提交只包含计划及必要收口文件；review、`e2e.md`、备份及用户原有未跟踪文件仍未提交。

计划终态：自动验收范围已完成；Agent/Chat + Sandbox、file-WS、Agent Site、RAGFlow Knowledge、Hindsight Memory 五类成功链继续按用户批准由人工执行，不能将已勾选步骤解读为这些外部成功链已经自动通过。
