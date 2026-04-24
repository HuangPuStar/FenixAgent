# Fixture: opencode 配置数据模型参考

> 基于 opencode 标准规范 (https://opencode.ai/config.json) 和实际 opencode.json 文件

## 1. 配置文件路径

| 项目 | 当前（错误） | 目标（正确） |
|------|-------------|-------------|
| 文件路径 | `~/.config/opencode/config.json` | `~/.config/opencode/opencode.json` |
| Schema | 无 | `$schema: "https://opencode.ai/config.json"` |

## 2. 完整配置文件结构

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "bailian-token-plan/qwen3.6-plus",
  "small_model": "bailian-token-plan/deepseek-v3.2",
  "provider": {
    "<provider-id>": { /* ProviderConfig */ }
  },
  "agent": {
    "<agent-id>": { /* AgentConfig */ }
  },
  "experimental": {},
  "plugin": [],
  "theme": "dark"
}
```

## 3. TypeScript 类型定义（对齐 opencode 标准）

### 3.1 Provider

```typescript
/** opencode 标准的 Provider 配置 */
export interface OpenCodeProvider {
  /** npm 包名，如 "@ai-sdk/openai-compatible" */
  npm: string;
  /** 人类可读名称，如 "ali" */
  name?: string;
  /** 连接选项 */
  options?: {
    baseURL?: string;
    apiKey?: string;
    [key: string]: unknown;
  };
  /** 此 Provider 下注册的模型 */
  models?: Record<string, OpenCodeModel>;
}

/** opencode 标准的 Model 配置 */
export interface OpenCodeModel {
  /** 显示名称，如 "Qwen3.6 Plus" */
  name?: string;
  /** 支持的模态 */
  modalities?: {
    input?: ("text" | "image")[];
    output?: ("text" | "image")[];
  };
  /** 模型限制 */
  limit?: {
    context?: number;
    output?: number;
  };
  /** 费用配置 */
  cost?: {
    input?: number;
    output?: number;
  };
  /** 模型选项（如 thinking 配置） */
  options?: Record<string, unknown>;
}
```

### 3.2 Agent

```typescript
/** opencode 标准的 Agent 配置 */
export interface OpenCodeAgent {
  /** 使用的模型，格式 "provider-id/model-id" */
  model?: string;
  /** 最大步数 */
  steps?: number;
  /** 运行模式 */
  mode?: "primary" | "subagent" | "all";
  /** 系统提示词 */
  prompt?: string;
  /** 可用工具列表 */
  tools?: string[];
  /** 权限配置 */
  permission?: Record<string, unknown>;
}
```

### 3.3 顶层字段

```typescript
/** opencode.json 顶层配置 */
export interface OpenCodeConfig {
  $schema?: string;
  /** 当前主模型，格式 "provider-id/model-id" */
  model?: string;
  /** 当前轻量模型，格式 "provider-id/model-id" */
  small_model?: string;
  /** Provider 配置映射 */
  provider?: Record<string, OpenCodeProvider>;
  /** Agent 配置映射 */
  agent?: Record<string, OpenCodeAgent>;
  /** 实验性功能 */
  experimental?: Record<string, unknown>;
  /** 插件列表 */
  plugin?: string[];
  /** 主题 */
  theme?: string;
}
```

## 4. API 响应类型（前后端协议）

### 4.1 Providers API

```typescript
// list 响应
interface ProviderListResponse {
  providers: Array<{
    id: string;              // provider 键名，如 "bailian-token-plan"
    name: string;            // 人类可读名称，如 "ali"
    npm: string;             // npm 包名
    configured: boolean;     // 是否有 apiKey
    keyHint: string | null;  // "****xxxx" 或 null
    baseURL: string | null;  // API 基础 URL
    modelCount: number;      // 注册模型数量
  }>;
}

// get 响应
interface ProviderDetailResponse {
  id: string;
  name: string;
  npm: string;
  keyHint: string | null;
  baseURL: string | null;
  options: Record<string, unknown>;
  models: Array<{
    id: string;              // 模型 ID，如 "qwen3.6-plus"
    name: string;            // 显示名称
    modalities: OpenCodeModel["modalities"];
    limit: OpenCodeModel["limit"];
    cost: OpenCodeModel["cost"];
  }>;
}

// set 请求体
interface ProviderSetRequest {
  id: string;
  data: {
    npm?: string;
    name?: string;
    baseURL?: string;
    apiKey?: string;
    models?: Record<string, OpenCodeModel>;
  };
}
```

### 4.2 Models API

```typescript
// get 响应
interface ModelsGetResponse {
  current: {
    model: string | null;        // "provider-id/model-id" 格式
    small_model: string | null;  // "provider-id/model-id" 格式
  };
  available: Array<{
    id: string;           // 模型 ID
    provider: string;     // provider ID
    fullId: string;       // "provider-id/model-id" 完整 ID
    label: string;        // 显示名称
    contextLimit: number | null;
    outputLimit: number | null;
  }>;
}

// set 请求体
interface ModelsSetRequest {
  model?: string;         // "provider-id/model-id"
  small_model?: string;   // "provider-id/model-id"
}
```

### 4.3 Agents API

```typescript
// 与现有结构基本一致，不变
interface AgentListResponse {
  default_agent: string | null;
  agents: Array<{
    name: string;
    builtIn: boolean;
    model: string | null;
    mode: string | null;
    steps: number | null;
  }>;
}
```

## 5. 示例 Fixture 数据

基于实际 `~/.config/opencode/opencode.json` 文件：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "bailian-token-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ali",
      "options": {
        "baseURL": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        "apiKey": "sk-sp-djI..."
      },
      "models": {
        "qwen3.6-plus": {
          "name": "Qwen3.6 Plus",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "options": { "thinking": { "type": "enabled", "budgetTokens": 8192 } },
          "limit": { "context": 1000000, "output": 65536 }
        },
        "MiniMax-M2.5": {
          "name": "MiniMax M2.5",
          "modalities": { "input": ["text"], "output": ["text"] },
          "options": { "thinking": { "type": "enabled", "budgetTokens": 8192 } },
          "limit": { "context": 196608, "output": 24576 }
        },
        "glm-5": {
          "name": "GLM-5",
          "modalities": { "input": ["text"], "output": ["text"] },
          "limit": { "context": 202752, "output": 16384 }
        },
        "deepseek-v3.2": {
          "name": "DeepSeek V3.2",
          "modalities": { "input": ["text"], "output": ["text"] },
          "limit": { "context": 131072, "output": 16384 }
        }
      }
    },
    "openai": {
      "npm": "@ai-sdk/openai",
      "name": "OpenAI",
      "options": {
        "apiKey": "sk-proj-abc..."
      },
      "models": {
        "gpt-4o": {
          "name": "GPT-4o",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 128000, "output": 16384 }
        },
        "gpt-4o-mini": {
          "name": "GPT-4o Mini",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 128000, "output": 16384 }
        }
      }
    }
  },
  "model": "bailian-token-plan/qwen3.6-plus",
  "small_model": "bailian-token-plan/deepseek-v3.2",
  "agent": {
    "build": { "model": "bailian-token-plan/qwen3.6-plus", "steps": 50, "mode": "primary" },
    "plan": { "model": "bailian-token-plan/qwen3.6-plus", "steps": 30, "mode": "primary" },
    "code-reviewer": { "model": "openai/gpt-4o", "mode": "subagent", "prompt": "Review code for bugs and improvements" }
  }
}
```

## 6. 数据结构映射（旧 → 新）

### Provider 字段映射

| 旧字段路径 | 新字段路径 | 说明 |
|-----------|-----------|------|
| `provider[name].apiKey` | `provider[id].options.apiKey` | apiKey 移入 options |
| `provider[name].baseURL` | `provider[id].options.baseURL` | baseURL 移入 options |
| _(无)_ | `provider[id].npm` | 新增：npm 包名 |
| `provider[name].name` | `provider[id].name` | 不变：人类可读名称 |
| _(无)_ | `provider[id].models` | 新增：模型嵌套在 provider 下 |

### Model 字段映射

| 旧概念 | 新概念 | 说明 |
|-------|--------|------|
| 独立 model section | `provider[id].models[modelId]` | 模型嵌套在 provider 下 |
| `ModelEntry.id` | `providerId + "/" + modelId` | 模型完整 ID 为 "provider/model" |
| `ModelEntry.provider` | 从 provider 遍历获得 | 不再需要单独字段 |

### Agent 字段映射

| 字段 | 变化 |
|------|------|
| `model` | 格式从 `"model-id"` 变为 `"provider-id/model-id"` |
| 其他字段 | 不变 |

## 7. 关键注意事项

1. **CONFIG_PATH 必须改为 opencode.json**：`src/services/config.ts` 中 `CONFIG_PATH` 从 `config.json` 改为 `opencode.json`
2. **Provider models 是嵌套结构**：遍历所有 provider.models 来构建 available 列表（models.ts 的 `buildAvailableList` 已经是正确的）
3. **模型 ID 使用 "provider/model" 格式**：顶层 `model` 和 `small_model` 使用 `"provider-id/model-id"` 格式
4. **apiKey 在 options 内**：读取和写入 apiKey 时路径为 `provider[id].options.apiKey`
5. **Skills 不在 JSON 中**：Skills 是文件系统管理，无需改动 JSON 读写逻辑
6. **Agent model 格式变化**：Agent 的 model 字段使用 "provider/model" 格式引用模型
