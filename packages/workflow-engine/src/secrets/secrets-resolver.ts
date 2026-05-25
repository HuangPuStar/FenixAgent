/**
 * Secrets 解析器 — 声明式密钥解析与脱敏。
 *
 * 优先级：系统环境变量 > .env 文件。
 * 提供 resolve() 批量解析密钥，redactSecrets() 对 metadata 做脱敏处理。
 */

import { WorkflowError, WorkflowErrorCode } from "../types/errors";

// ---------- 类型 ----------

/** SecretsResolver 构造选项 */
export interface SecretsResolverOptions {
  /** .env 文件路径，缺省时不从文件读取 */
  envFile?: string;
}

// ---------- 内部工具 ----------

/**
 * 简易 .env 解析器（无外部依赖）。
 * 支持 KEY=VALUE、# 注释、空行、双引号包裹值。
 * 不支持变量展开（$VAR）。
 */
async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return {};

  const text = await file.text();
  const result: Record<string, string> = {};

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    // 跳过空行和注释
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue; // 无效行，跳过

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    // 去除首尾双引号
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

// ---------- SecretsResolver ----------

/**
 * 密钥解析与脱敏器。
 *
 * 使用方式：
 * ```ts
 * const resolver = new SecretsResolver({ envFile: '.env' });
 * const secrets = await resolver.resolve(['API_KEY', 'DB_PASSWORD']);
 * const safe = resolver.redactSecrets(metadata, secrets);
 * ```
 */
export class SecretsResolver {
  private readonly envFilePath?: string;
  private envFileCache?: Record<string, string>;
  private envFileLoaded = false;

  constructor(options?: SecretsResolverOptions) {
    this.envFilePath = options?.envFile;
  }

  /**
   * 解析所有声明的密钥。
   * 优先级：系统环境变量 > .env 文件。
   * 如果密钥不存在，抛 WorkflowError(SECRET_NOT_FOUND)。
   */
  async resolve(declaredSecrets: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    // 懒加载 .env 文件（仅首次调用时读取）
    const envFileValues = await this.loadEnvFile();

    for (const key of declaredSecrets) {
      // 优先系统环境变量
      const value = process.env[key] ?? envFileValues[key];

      if (value === undefined) {
        throw new WorkflowError(
          `Secret "${key}" not found in environment variables or .env file`,
          WorkflowErrorCode.SECRET_NOT_FOUND,
          { key },
        );
      }

      result[key] = value;
    }

    return result;
  }

  /**
   * 脱敏 — 将已知 secret 值替换为 `***`。
   * 用于事件写入前清理 metadata，防止密钥泄露。
   *
   * - 递归处理嵌套对象和数组
   * - 仅替换字符串中的精确匹配（不替换子串）
   * - 返回新对象，不修改输入
   */
  redactSecrets(metadata: Record<string, unknown>, secretValues: Record<string, string>): Record<string, unknown> {
    return this.redactValue(metadata, secretValues) as Record<string, unknown>;
  }

  // ---------- 内部方法 ----------

  /** 懒加载 .env 文件内容 */
  private async loadEnvFile(): Promise<Record<string, string>> {
    if (this.envFileLoaded) return this.envFileCache ?? {};

    this.envFileLoaded = true;

    if (!this.envFilePath) {
      this.envFileCache = {};
      return {};
    }

    this.envFileCache = await parseEnvFile(this.envFilePath);
    return this.envFileCache;
  }

  /** 递归脱敏任意值 */
  private redactValue(value: unknown, secretValues: Record<string, string>): unknown {
    if (typeof value === "string") {
      // 精确匹配替换：整个值等于某个 secret 时才替换
      if (Object.values(secretValues).includes(value)) {
        return "***";
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, secretValues));
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = this.redactValue(v, secretValues);
      }
      return result;
    }

    // number / boolean / null 等原样返回
    return value;
  }
}
