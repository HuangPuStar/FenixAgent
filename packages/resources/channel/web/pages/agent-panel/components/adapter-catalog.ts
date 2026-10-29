/**
 * 平台侧维护的 LangBot 内置适配器目录。
 *
 * LangBot 的适配器列表只对 WebUI 用户 token 开放，Service API 取不到；这里列平台部署可用的内置适配器，
 * 插件适配器走「自定义」由用户填 ID 与 JSON。officialaccount-omni 与 wecomcs-omni 依赖公网 webhook
 * 回调，当前平台不提供服务，故不列入。
 *
 * Service API 不会补 manifest 默认值，适配器代码却会直接索引部分键（如 telegram 的
 * markdown_card），因此默认值必须由这里镜像并随配置提交；`implicit` 字段只提交、不渲染。
 */
export type AdapterFieldKind = "text" | "secret" | "boolean" | "select";

/** `select` 字段的候选值；`labelKey` 走 channels 命名空间。 */
export interface AdapterFieldOption {
  readonly value: string;
  readonly labelKey: string;
}

export interface AdapterField {
  readonly key: string;
  readonly labelKey: string;
  readonly kind: AdapterFieldKind;
  readonly required?: boolean;
  /** 无需用户输入的上游必填开关，始终按 defaultValue 提交。 */
  readonly implicit?: boolean;
  /** 未填写时的提交值：布尔字段的初始值，或文本 / 枚举字段的缺省值。 */
  readonly defaultValue?: string | boolean;
  /** 仅 select 字段使用。 */
  readonly options?: readonly AdapterFieldOption[];
}

export interface AdapterDefinition {
  readonly id: string;
  readonly labelKey: string;
  readonly fields: readonly AdapterField[];
}

export const CUSTOM_ADAPTER_ID = "__custom__";

export const BUILTIN_ADAPTERS: readonly AdapterDefinition[] = [
  {
    id: "telegram-omni",
    labelKey: "langbot.bots.adapters.telegram",
    fields: [
      { key: "token", labelKey: "langbot.bots.fields.token", kind: "secret", required: true },
      {
        key: "markdown_card",
        labelKey: "langbot.bots.fields.markdownCard",
        kind: "boolean",
        defaultValue: true,
      },
      {
        key: "enable-stream-reply",
        labelKey: "langbot.bots.fields.enableStreamReply",
        kind: "boolean",
        implicit: true,
        defaultValue: false,
      },
    ],
  },
  {
    id: "lark-omni",
    labelKey: "langbot.bots.adapters.lark",
    fields: [
      { key: "app_id", labelKey: "langbot.bots.fields.appId", kind: "text", required: true },
      { key: "app_secret", labelKey: "langbot.bots.fields.appSecret", kind: "secret", required: true },
      {
        key: "enable-webhook",
        labelKey: "langbot.bots.fields.enableWebhook",
        kind: "boolean",
        implicit: true,
        defaultValue: false,
      },
      {
        key: "enable-stream-reply",
        labelKey: "langbot.bots.fields.enableStreamReply",
        kind: "boolean",
        implicit: true,
        defaultValue: false,
      },
    ],
  },
  {
    id: "slack-omni",
    labelKey: "langbot.bots.adapters.slack",
    fields: [
      { key: "bot_token", labelKey: "langbot.bots.fields.botToken", kind: "secret", required: true },
      // manifest 标 optional，但默认 socket_mode=false 时上游把它放进 required_keys，缺失直接拒绝启动。
      { key: "signing_secret", labelKey: "langbot.bots.fields.signingSecret", kind: "secret", required: true },
      {
        key: "socket_mode",
        labelKey: "langbot.bots.fields.socketMode",
        kind: "boolean",
        implicit: true,
        defaultValue: false,
      },
    ],
  },
  {
    id: "discord-omni",
    labelKey: "langbot.bots.adapters.discord",
    fields: [
      { key: "client_id", labelKey: "langbot.bots.fields.clientId", kind: "text", required: true },
      { key: "token", labelKey: "langbot.bots.fields.token", kind: "secret", required: true },
    ],
  },
  {
    id: "wecom-omni",
    labelKey: "langbot.bots.adapters.wecom",
    fields: [
      { key: "corpid", labelKey: "langbot.bots.fields.corpid", kind: "text", required: true },
      { key: "secret", labelKey: "langbot.bots.fields.secret", kind: "secret", required: true },
      { key: "token", labelKey: "langbot.bots.fields.token", kind: "secret", required: true },
      { key: "EncodingAESKey", labelKey: "langbot.bots.fields.encodingAesKey", kind: "secret", required: true },
    ],
  },
  {
    id: "wecombot-omni",
    labelKey: "langbot.bots.adapters.wecombot",
    fields: [
      { key: "BotId", labelKey: "langbot.bots.fields.botId", kind: "text", required: true },
      { key: "Secret", labelKey: "langbot.bots.fields.botSecret", kind: "secret", required: true },
      // 默认 WebSocket 长连接模式；webhook 需要公网回调地址，用户自行在 LangBot 侧开启。
      {
        key: "enable-webhook",
        labelKey: "langbot.bots.fields.enableWebhook",
        kind: "boolean",
        implicit: true,
        defaultValue: false,
      },
    ],
  },
  {
    id: "dingtalk-omni",
    labelKey: "langbot.bots.adapters.dingtalk",
    fields: [
      { key: "client_id", labelKey: "langbot.bots.fields.clientId", kind: "text", required: true },
      { key: "client_secret", labelKey: "langbot.bots.fields.clientSecret", kind: "secret", required: true },
      {
        key: "markdown_card",
        labelKey: "langbot.bots.fields.markdownCard",
        kind: "boolean",
        defaultValue: true,
      },
      {
        key: "card_auto_layout",
        labelKey: "langbot.bots.fields.cardAutoLayout",
        kind: "boolean",
        implicit: true,
        defaultValue: true,
      },
    ],
  },
  {
    id: "kook-omni",
    labelKey: "langbot.bots.adapters.kook",
    fields: [
      { key: "token", labelKey: "langbot.bots.fields.token", kind: "secret", required: true },
      {
        key: "enable-stream-reply",
        labelKey: "langbot.bots.fields.enableStreamReply",
        kind: "boolean",
        implicit: true,
        defaultValue: false,
      },
    ],
  },
  {
    id: "qqofficial-omni",
    labelKey: "langbot.bots.adapters.qqofficial",
    fields: [
      { key: "appid", labelKey: "langbot.bots.fields.appid", kind: "text", required: true },
      { key: "secret", labelKey: "langbot.bots.fields.secret", kind: "secret", required: true },
      {
        key: "enable-markdown-rendering",
        labelKey: "langbot.bots.fields.enableMarkdownRendering",
        kind: "boolean",
        implicit: true,
        defaultValue: false,
      },
      {
        key: "enable-webhook",
        labelKey: "langbot.bots.fields.enableWebhook",
        kind: "boolean",
        implicit: true,
        defaultValue: false,
      },
      {
        key: "enable-stream-reply",
        labelKey: "langbot.bots.fields.enableStreamReply",
        kind: "boolean",
        implicit: true,
        defaultValue: false,
      },
    ],
  },
  {
    id: "onebot-v11",
    labelKey: "langbot.bots.adapters.onebot",
    fields: [
      {
        key: "connection_mode",
        labelKey: "langbot.bots.fields.connectionMode",
        kind: "select",
        required: true,
        defaultValue: "reverse_ws",
        options: [
          { value: "reverse_ws", labelKey: "langbot.bots.fields.connectionModeReverseWs" },
          { value: "forward_ws", labelKey: "langbot.bots.fields.connectionModeForwardWs" },
        ],
      },
      // 仅 forward_ws 需要用户填写；reverse_ws 由 LangBot 监听，上游会忽略该键。
      { key: "ws_url", labelKey: "langbot.bots.fields.wsUrl", kind: "text" },
      { key: "access-token", labelKey: "langbot.bots.fields.accessToken", kind: "secret", required: true },
      { key: "self_id", labelKey: "langbot.bots.fields.selfId", kind: "text" },
    ],
  },
];

export function findBuiltinAdapter(adapterId: string): AdapterDefinition | undefined {
  return BUILTIN_ADAPTERS.find((adapter) => adapter.id === adapterId);
}

/** 布尔字段的当前值：用户未动过时取目录里的默认值。 */
export function booleanFieldValue(field: AdapterField, values: Readonly<Record<string, string | boolean>>): boolean {
  const value = values[field.key];
  if (typeof value === "boolean") return value;
  return typeof field.defaultValue === "boolean" ? field.defaultValue : false;
}

/**
 * 把表单值收敛为适配器配置：文本/密钥/枚举只提交填写项（枚举未选时用缺省值），布尔与隐式字段始终提交。
 *
 * 空字段必须省略而不是提交空串；创建模式依赖这里补齐 manifest 默认值。编辑模式不能直接用它的
 * `config`，要用 {@link pickChangedAdapterConfig} 只保留用户改过的键（LangBot 侧按合并语义更新）。
 */
export function buildAdapterConfig(
  definition: AdapterDefinition,
  values: Readonly<Record<string, string | boolean>>,
): { config: Record<string, unknown>; missing: readonly AdapterField[] } {
  const config: Record<string, unknown> = {};
  const missing: AdapterField[] = [];

  for (const field of definition.fields) {
    if (field.implicit) {
      if (field.defaultValue !== undefined) config[field.key] = field.defaultValue;
      continue;
    }
    if (field.kind === "boolean") {
      config[field.key] = booleanFieldValue(field, values);
      continue;
    }
    const raw = values[field.key];
    const typed = (typeof raw === "string" ? raw : "").trim();
    const fallback = typeof field.defaultValue === "string" ? field.defaultValue : "";
    const value = typed || fallback;
    if (!value) {
      if (field.required) missing.push(field);
      continue;
    }
    config[field.key] = value;
  }

  return { config, missing };
}

/**
 * 编辑模式只保留用户实际改过的键。
 *
 * LangBot 的 PUT 会把提交的 config 与远端现有值合并；把目录默认值一并提交会把用户在 LangBot
 * 侧改过的开关重置回默认，而 `fieldValues` 里没有出现过的键正是用户未操作的部分。
 */
export function pickChangedAdapterConfig(
  config: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, string | boolean>>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(values)) {
    if (key in config) changed[key] = config[key];
  }
  return changed;
}
