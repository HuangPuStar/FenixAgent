// === opencode 标准类型 ===

// === Permission 类型定义 ===

/** 开关型工具的三态值 */
export type PermissionAction = "ask" | "allow" | "deny";

/** 规则型工具的值：全局策略字符串 或 pattern→action 映射 */
export type RuleBasedPermission = PermissionAction | Record<string, PermissionAction>;

/** 完整的 PermissionConfig 对象模式 */
export interface PermissionObjectConfig {
    // 规则型工具（支持通配符匹配）
    read?: RuleBasedPermission;
    edit?: RuleBasedPermission;
    glob?: RuleBasedPermission;
    grep?: RuleBasedPermission;
    list?: RuleBasedPermission;
    bash?: RuleBasedPermission;
    task?: RuleBasedPermission;
    external_directory?: RuleBasedPermission;
    lsp?: RuleBasedPermission;
    skill?: RuleBasedPermission;
    // 开关型工具（仅支持三态字符串）
    todowrite?: PermissionAction;
    question?: PermissionAction;
    webfetch?: PermissionAction;
    websearch?: PermissionAction;
    codesearch?: PermissionAction;
    doom_loop?: PermissionAction;
}

/** PermissionConfig: 字符串模式（全局策略）或对象模式（按工具配置） */
export type PermissionConfig = PermissionAction | PermissionObjectConfig;

export interface OpenCodeModel {
    name?: string;
    modalities?: {
        input?: ("text" | "image")[];
        output?: ("text" | "image")[];
    };
    limit?: {
        context?: number;
        output?: number;
    };
    cost?: {
        input?: number;
        output?: number;
    };
    options?: Record<string, unknown>;
}

export interface OpenCodeProvider {
    npm: string;
    name?: string;
    options?: {
        apiKey?: string;
        baseURL?: string;
        [key: string]: unknown;
    };
    models?: Record<string, OpenCodeModel>;
}

export interface OpenCodeAgent {
    model?: string;
    steps?: number;
    mode?: "primary" | "subagent" | "all";
    prompt?: string;
    tools?: string[];
    permission?: PermissionConfig;
}

export interface OpenCodeConfig {
    $schema?: string;
    model?: string;
    small_model?: string;
    provider?: Record<string, OpenCodeProvider>;
    agent?: Record<string, OpenCodeAgent>;
    experimental?: Record<string, unknown>;
    plugin?: string[];
    theme?: string;
}

// === API 响应类型 ===

// --- Providers ---

export interface ProviderInfo {
    id: string;
    name: string;
    npm: string | null;
    configured: boolean;
    keyHint: string | null;
    baseURL: string | null;
    modelCount: number;
}

export interface ProviderModel {
    id: string;
    name: string;
    modalities: unknown;
    limit: unknown;
    cost: unknown;
}

export interface ProviderDetail {
    id: string;
    name: string;
    npm: string | null;
    keyHint: string | null;
    baseURL: string | null;
    options: Record<string, unknown>;
    models: ProviderModel[];
}

// --- Models ---

export interface ModelEntry {
    id: string;
    provider: string;
    fullId: string;
    label: string;
    contextLimit: number | null;
    outputLimit: number | null;
}

export interface ModelConfig {
    current: {
        model: string | null;
        small_model: string | null;
        permission: PermissionConfig | null;
    };
    available: ModelEntry[];
}

// --- Agents ---

export interface AgentInfo {
    name: string;
    builtIn: boolean;
    model: string | null;
    mode: string | null;
    description: string | null;
    color: string | null;
}

export interface AgentDetail {
    name: string;
    builtIn: boolean;
    model: string | null;
    prompt: string | null;
    tools: Record<string, boolean> | null;
    steps: number | null;
    mode: string | null;
    permission: PermissionConfig | null;
    variant: string | null;
    temperature: number | null;
    top_p: number | null;
    disable: boolean;
    hidden: boolean;
    color: string | null;
    description: string | null;
}

// --- Skills ---

export interface SkillInfo {
    name: string;
    enabled: boolean;
    description: string;
    path: string;
}

export interface SkillDetail {
    name: string;
    description: string;
    content: string;
    enabled: boolean;
    path: string;
    metadata: Record<string, string>;
}

// === Generic API Response ===

export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: { code: string; message: string };
}
