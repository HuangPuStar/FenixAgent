# Agent 首页实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/agent/home` 首页，提供 AI 智能生成和模板一键创建两种方式创建智能体。

**Architecture:** 后端新增一个 `POST /web/agent-generation` 接口，使用 OpenAI SDK 调用轻量模型做结构化输出；前端新增路由页面和表单组件，三阶段状态管理（idle → generating → form）。

**Tech Stack:** Elysia（后端路由）、OpenAI SDK（LLM 调用）、React 19 + TanStack Router（前端）、react-i18next（国际化）、lucide-react（图标）

---

## Task 1: 安装 OpenAI SDK 依赖

**Files:**
- Modify: `package.json`（自动）

- [ ] **Step 1: 安装 openai 包**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun add openai
```

- [ ] **Step 2: 验证安装成功**

```bash
bun -e "const { OpenAI } = require('openai'); console.log(typeof OpenAI)"
```
Expected: `function`

- [ ] **Step 3: 提交**

```bash
git add package.json bun.lock && git commit -m "chore: 添加 openai SDK 依赖"
```

---

## Task 2: 注册环境变量

**Files:**
- Modify: `src/env.ts:66-70`（在 Hindsight 环境变量之后添加）

- [ ] **Step 1: 在 envSchema 中新增三个可选字段**

在 `src/env.ts` 的 `envSchema` 中，`HINDSIGHT_MCP_URL` 之后添加：

```typescript
  // ── 可选：Agent 智能生成 ──
  RCS_GENERATION_MODEL_ENDPOINT: z.string().optional(),
  RCS_GENERATION_MODEL_KEY: z.string().optional(),
  RCS_GENERATION_MODEL_NAME: z.string().optional(),
```

- [ ] **Step 2: 验证 tsc 通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -20
```
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/env.ts && git commit -m "feat: 注册 Agent 智能生成相关环境变量"
```

---

## Task 3: 实现 Agent 生成服务层

**Files:**
- Create: `src/services/agent-generation.ts`

- [ ] **Step 1: 创建服务文件**

```typescript
import OpenAI from "openai";
import { env } from "../env";
import { listSkills } from "./config/skill";
import type { AuthContext } from "../plugins/auth";

/** Agent 智能生成结果 */
export interface AgentGenerationResult {
  name: string;
  systemPrompt: string;
  skills: string[];
}

/** 检查生成功能是否已配置 */
export function isGenerationConfigured(): boolean {
  return !!(env.RCS_GENERATION_MODEL_ENDPOINT && env.RCS_GENERATION_MODEL_KEY && env.RCS_GENERATION_MODEL_NAME);
}

/** 调用 LLM 生成 Agent 配置 */
export async function generateAgentConfig(ctx: AuthContext, prompt: string): Promise<AgentGenerationResult> {
  if (!isGenerationConfigured()) {
    throw new Error("NOT_CONFIGURED");
  }

  // 查询当前组织所有可用 skills
  const skills = await listSkills(ctx);
  const skillList = skills.map((s) => `- ${s.name}: ${s.description ?? ""}`).join("\n");

  const systemPrompt = `你是一个智能体配置生成助手。根据用户的需求描述，生成智能体的配置信息。

你需要返回一个 JSON 对象，包含以下字段：
- name: 智能体的英文名称，使用 kebab-case 格式（如 weekly-report-assistant），1-64字符
- systemPrompt: 智能体的系统提示词，详细描述智能体的角色和行为
- skills: 推荐启用的技能名称数组，从下面的可用技能列表中选择

可用技能列表：
${skillList || "（暂无可用技能）"}

请只返回 JSON，不要包含其他内容。`;

  const client = new OpenAI({
    apiKey: env.RCS_GENERATION_MODEL_KEY,
    baseURL: env.RCS_GENERATION_MODEL_ENDPOINT,
  });

  const response = await client.chat.completions.create({
    model: env.RCS_GENERATION_MODEL_NAME!,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("PARSE_ERROR");
  }

  let parsed: { name?: string; systemPrompt?: string; skills?: string[] };
  try {
    parsed = JSON.parse(content) as { name?: string; systemPrompt?: string; skills?: string[] };
  } catch {
    throw new Error("PARSE_ERROR");
  }

  if (!parsed.name || !parsed.systemPrompt) {
    throw new Error("PARSE_ERROR");
  }

  // 将 LLM 返回的 skill 名称映射为真实 skill ID
  const skillNameToId = new Map(skills.map((s) => [s.name.toLowerCase(), s.id ?? s.name]));
  const mappedSkills = (parsed.skills ?? [])
    .map((name: string) => skillNameToId.get(name.toLowerCase()))
    .filter((id): id is string => !!id);

  return {
    name: parsed.name,
    systemPrompt: parsed.systemPrompt,
    skills: mappedSkills,
  };
}
```

- [ ] **Step 2: 验证 tsc 通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -20
```
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/services/agent-generation.ts && git commit -m "feat: 实现 Agent 智能生成服务层"
```

---

## Task 4: 实现 Agent 生成路由

**Files:**
- Create: `src/routes/web/agent-generation.ts`
- Modify: `src/routes/web/index.ts`

- [ ] **Step 1: 创建路由文件**

```typescript
import { z } from "zod/v4";
import { authGuardPlugin } from "../../plugins/auth";
import { generateAgentConfig, isGenerationConfigured } from "../../services/agent-generation";
import { configError, configSuccess } from "../../services/config-utils";

const GenerationBodySchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
});

const app = new Elysia({ name: "web-agent-generation" }).use(authGuardPlugin).model({
  "generation-body": GenerationBodySchema,
});

app.post(
  "/agent-generation",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;

    if (!isGenerationConfigured()) {
      return error(503, configError("NOT_CONFIGURED", "Agent generation model is not configured"));
    }

    try {
      const result = await generateAgentConfig(authCtx, body.prompt as string);
      return configSuccess(result);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === "NOT_CONFIGURED") {
          return error(503, configError("NOT_CONFIGURED", "Agent generation model is not configured"));
        }
        if (err.message === "PARSE_ERROR") {
          return error(422, configError("PARSE_ERROR", "Failed to parse AI response"));
        }
      }
      console.error("[agent-generation] LLM call failed:", err);
      return error(500, configError("LLM_ERROR", "Failed to generate agent configuration"));
    }
  },
  { sessionAuth: true, body: "generation-body", detail: { tags: ["Agent"], summary: "Agent 智能生成" } },
);

export default app;
```

- [ ] **Step 2: 在 web/index.ts 注册路由**

在 `src/routes/web/index.ts` 中添加 import 和 `.use()`：

```typescript
// 在 import 区域添加
import webAgentGeneration from "./agent-generation";

// 在 .use(webWorkflowSse) 之前添加
  .use(webAgentGeneration)
```

- [ ] **Step 3: 验证 tsc 通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -20
```
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add src/routes/web/agent-generation.ts src/routes/web/index.ts && git commit -m "feat: 新增 POST /web/agent-generation 接口"
```

---

## Task 5: 新增 i18n 翻译文件和注册命名空间

**Files:**
- Create: `web/src/i18n/locales/en/agentHome.json`
- Create: `web/src/i18n/locales/zh/agentHome.json`
- Modify: `web/src/i18n/index.ts`

- [ ] **Step 1: 创建英文翻译文件**

`web/src/i18n/locales/en/agentHome.json`:

```json
{
  "title1": "Build Your Agent",
  "title2": "Summon Your Agent with One Sentence",
  "title3": "One Command, Agent Go",
  "subtitle": "Say one sentence, leave the rest to Agent",
  "inputPlaceholder": "Describe what you want your Agent to do...",
  "enterHint": "Enter ↵",
  "orTemplate": "Or start from a template",
  "loadingTitle": "Agent is analyzing your needs...",
  "loadingSubtitle": "Matching the best Skills and configuration",
  "editInput": "Edit",
  "nameLabel": "Name",
  "promptLabel": "System Prompt",
  "skillsLabel": "Skills",
  "addSkill": "Add Skill",
  "createButton": "Create Agent",
  "createFailed": "Failed to create Agent",
  "generationFailed": "Failed to generate configuration, please try again"
}
```

- [ ] **Step 2: 创建中文翻译文件**

`web/src/i18n/locales/zh/agentHome.json`:

```json
{
  "title1": "打造专属 Agent",
  "title2": "一句话，召唤 Agent",
  "title3": "一声令下，Agent 出发",
  "subtitle": "说一句话，剩下的交给 Agent",
  "inputPlaceholder": "描述你想要的 Agent 能力...",
  "enterHint": "Enter ↵",
  "orTemplate": "或从模板快速开始",
  "loadingTitle": "Agent 正在分析你的需求...",
  "loadingSubtitle": "正在匹配最佳 Skills 和配置",
  "editInput": "编辑",
  "nameLabel": "名称",
  "promptLabel": "System Prompt",
  "skillsLabel": "Skills",
  "addSkill": "添加 Skill",
  "createButton": "创建 Agent",
  "createFailed": "创建 Agent 失败",
  "generationFailed": "生成配置失败，请重试"
}
```

- [ ] **Step 3: 在 index.ts 注册命名空间**

在 `web/src/i18n/index.ts` 中：

1. 添加 import（在 skillsZH 之后）：
```typescript
import agentHomeEN from "./locales/en/agentHome.json";
import agentHomeZH from "./locales/zh/agentHome.json";
```

2. 在 `NS` 对象中添加：
```typescript
  AGENT_HOME: "agentHome",
```

3. 在 en resources 中添加：
```typescript
[NS.AGENT_HOME]: agentHomeEN,
```

4. 在 zh resources 中添加：
```typescript
[NS.AGENT_HOME]: agentHomeZH,
```

5. 在 ns 数组中添加 `NS.AGENT_HOME`

- [ ] **Step 4: 验证 tsc 通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -20
```

- [ ] **Step 5: 提交**

```bash
git add web/src/i18n/ && git commit -m "feat: 新增 agentHome i18n 命名空间"
```

---

## Task 6: 创建 AgentGenerationForm 组件

**Files:**
- Create: `web/src/pages/agent-panel/components/AgentGenerationForm.tsx`

- [ ] **Step 1: 创建表单组件**

组件接收 `initialData`（AI 生成结果）、`onCreate` 回调、`loading` 状态。包含名称 input、system prompt textarea、skills 标签组（带删除和添加）、创建按钮。

```tsx
import { Pencil, Plus, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NS } from "../../../i18n";

export interface GenerationFormData {
  name: string;
  systemPrompt: string;
  skills: string[];
}

interface AgentGenerationFormProps {
  initialData: GenerationFormData;
  onCreate: (data: GenerationFormData) => Promise<void>;
  loading?: boolean;
}

export function AgentGenerationForm({ initialData, onCreate, loading }: AgentGenerationFormProps) {
  const { t } = useTranslation(NS.AGENT_HOME);
  const [name, setName] = useState(initialData.name);
  const [systemPrompt, setSystemPrompt] = useState(initialData.systemPrompt);
  const [skills, setSkills] = useState(initialData.skills);
  const [newSkill, setNewSkill] = useState("");

  const handleRemoveSkill = useCallback((skill: string) => {
    setSkills((prev) => prev.filter((s) => s !== skill));
  }, []);

  const handleAddSkill = useCallback(() => {
    const trimmed = newSkill.trim();
    if (trimmed && !skills.includes(trimmed)) {
      setSkills((prev) => [...prev, trimmed]);
    }
    setNewSkill("");
  }, [newSkill, skills]);

  const handleSubmit = useCallback(async () => {
    try {
      await onCreate({ name, systemPrompt, skills });
    } catch (err) {
      toast.error(t("createFailed"));
      console.error(err);
    }
  }, [name, systemPrompt, skills, onCreate, t]);

  return (
    <div className="w-full max-w-[600px] rounded-2xl border border-gray-200/50 bg-white/75 p-6 shadow-sm backdrop-blur-[10px]">
      <div className="flex flex-col gap-5">
        {/* 名称 */}
        <div>
          <Label className="mb-1.5 text-xs font-semibold tracking-wide text-gray-700">{t("nameLabel")}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl border-gray-200 bg-gray-50 text-sm" />
        </div>

        {/* System Prompt */}
        <div>
          <Label className="mb-1.5 text-xs font-semibold tracking-wide text-gray-700">{t("promptLabel")}</Label>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            className="min-h-[80px] rounded-xl border-gray-200 bg-gray-50 text-sm leading-relaxed"
          />
        </div>

        {/* Skills */}
        <div>
          <Label className="mb-1.5 text-xs font-semibold tracking-wide text-gray-700">{t("skillsLabel")}</Label>
          <div className="flex flex-wrap gap-2">
            {skills.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-600/20 bg-cyan-600/10 px-3 py-1.5 text-xs font-medium text-cyan-700"
              >
                {skill}
                <button type="button" onClick={() => handleRemoveSkill(skill)} className="text-cyan-600/40 hover:text-cyan-600">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <div className="flex items-center gap-1">
              <Input
                value={newSkill}
                onChange={(e) => setNewSkill(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddSkill()}
                placeholder={t("addSkill")}
                className="h-7 w-28 rounded-md border-dashed border-gray-300 bg-gray-50 px-2 text-xs"
              />
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleAddSkill}>
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>

        {/* 创建按钮 */}
        <Button
          onClick={handleSubmit}
          disabled={loading || !name.trim()}
          className="mt-1 rounded-xl bg-gradient-to-r from-cyan-600 to-teal-600 px-4 py-3.5 text-sm font-semibold tracking-wide text-white shadow-[0_4px_16px_rgba(8,145,178,0.25)] hover:from-cyan-700 hover:to-teal-700"
        >
          {loading ? "..." : t("createButton")}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 验证 tsc 通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -20
```

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/agent-panel/components/AgentGenerationForm.tsx && git commit -m "feat: 新增 AgentGenerationForm 表单组件"
```

---

## Task 7: 创建 AgentHomePage 页面组件

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentHomePage.tsx`

这是核心页面，包含三阶段状态管理、模板加载、AI 生成调用、创建智能体。

- [ ] **Step 1: 创建页面组件**

组件要点：
- 状态：`idle | generating | form`，通过 useState 管理
- idle 阶段：居中输入框 + 模板卡片网格
- generating 阶段：输入框锁定 + loading 动画
- form 阶段：输入框可编辑 + AgentGenerationForm
- 标题随机从三条中选一条（useMemo + Math.random，每次挂载时决定）
- 模板通过 `agentApi.templates()` 加载
- 点击模板直接调 `agentApi.create()` 创建并跳转
- 输入框 Enter 后调 `/web/agent-generation`
- 创建成功后 navigate 到 `/agent/chat/{agentId}`

视觉实现：
- 全铺满渐变背景：`bg-gradient-to-br from-[#f0fdfa] via-[#ecfeff] to-[#ecfdf5]`
- 标题波浪装饰：内联 SVG，青→翠→金渐变
- 输入框流光边框：CSS animation + gradient border
- 模板卡片：左侧渐变图标方块 + 右侧文字，6 种图标色系循环
- 背景装饰光斑：absolute positioned radial-gradient divs

图标色系映射（按模板索引循环）：
```typescript
const TEMPLATE_COLORS = [
  { from: "#0891b2", to: "#22d3ee", shadow: "rgba(8,145,178,0.25)" },   // 青
  { from: "#0d9488", to: "#2dd4bf", shadow: "rgba(13,148,136,0.25)" },  // 翠绿
  { from: "#d97706", to: "#fbbf24", shadow: "rgba(217,119,6,0.25)" },   // 琥珀
  { from: "#2563eb", to: "#60a5fa", shadow: "rgba(37,99,235,0.25)" },   // 蓝
  { from: "#059669", to: "#34d399", shadow: "rgba(5,150,105,0.25)" },   // 翡翠
  { from: "#0284c7", to: "#38bdf8", shadow: "rgba(2,132,199,0.25)" },   // 天蓝
];
```

每个模板卡片根据 `index % 6` 取色。图标使用 lucide-react 的 `Pencil`, `FileText`, `Search`, `FileCode`, `Wand2`, `BookOpen` 按 index 循环。

- [ ] **Step 2: 验证 tsc 通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -20
```

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/agent-panel/pages/AgentHomePage.tsx && git commit -m "feat: 新增 AgentHomePage 页面组件"
```

---

## Task 8: 创建路由文件

**Files:**
- Create: `web/src/routes/agent/_panel/home.tsx`

- [ ] **Step 1: 创建路由文件**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentHomePage").then((m) => ({ default: m.AgentHomePage })),
);

export const Route = createFileRoute("/agent/_panel/home")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <Page />
    </Suspense>
  ),
});
```

- [ ] **Step 2: 验证 TanStack Router 生成路由树**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run dev:web &
sleep 5 && kill %1 2>/dev/null; echo "done"
```
检查 `web/src/routeTree.gen.ts` 是否自动更新包含 `home` 路由。

- [ ] **Step 3: 验证 tsc 通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -20
```

- [ ] **Step 4: 提交**

```bash
git add web/src/routes/agent/_panel/home.tsx web/src/routeTree.gen.ts && git commit -m "feat: 新增 /agent/home 路由"
```

---

## Task 9: 左上角 Logo 添加首页导航

**Files:**
- Modify: `web/src/pages/agent-panel/AgentSidebar.tsx`（logo 区域）

- [ ] **Step 1: 在 logo 区域添加 Link 导航**

在 `AgentSidebar.tsx` 中，找到 logo 展示区域（img 或 monogram div），用 `<Link to="/agent/home">` 包裹。需要从 `@tanstack/react-router` import `Link`。

具体修改：在 logo img 和 monogram div 的外层添加：

```tsx
import { Link } from "@tanstack/react-router";

// 在 logo 展示代码外层用 Link 包裹
<Link to="/agent/home" className="flex items-center gap-2">
  {/* 原有的 logo img / monogram div / brand name */}
</Link>
```

- [ ] **Step 2: 验证 tsc 通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -20
```

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/agent-panel/AgentSidebar.tsx && git commit -m "feat: 左上角 Logo 添加首页导航"
```

---

## Task 10: precheck 与最终验证

**Files:**
- 全局

- [ ] **Step 1: 运行 precheck**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```
Expected: 全部通过

- [ ] **Step 2: 修复 precheck 发现的问题（如有）**

根据 precheck 输出修复格式、import 排序等问题。

- [ ] **Step 3: 构建前端**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web
```
Expected: 构建成功

- [ ] **Step 4: 最终提交**

```bash
git add -A && git commit -m "chore: precheck 修复和前端构建"
```
