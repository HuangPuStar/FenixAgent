/**
 * docker/deploy.env 的 feature 开关解析（拓扑的「这台机器开了哪些栈」维度）。
 *
 * 约定来自 docker/lib/config.sh：开关键与依赖目录一一对应（`FENIX_FEATURE_<目录名大写，- 换 _>`），
 * common 的可选服务则用其 compose profile 名（`FENIX_FEATURE_MYSQL` / `_S3` / `_REDIS`）。
 * 这里只读 `FENIX_FEATURE_*` 键：deploy.env 按仓库约定不含密钥，其余键（端口等）与拓扑无关。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type FeatureState = "enabled" | "disabled" | "unset";

export type FeatureFlags = {
  /** 相对仓库根的文件路径；无配置文件时为 null */
  source: string | null;
  /** 开关键 → 是否打开（只含显式写出的键） */
  values: Record<string, boolean>;
  warnings: string[];
};

export function loadFeatureFlags(configFile: string, repoRoot: string): FeatureFlags {
  if (!existsSync(configFile)) {
    return { source: null, values: {}, warnings: ["未找到 docker/deploy.env，开关状态未知（视作未声明）"] };
  }

  const warnings: string[] = [];
  const values: Record<string, boolean> = {};
  const lines = readFileSync(configFile, "utf8").split("\n");

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      warnings.push(`${path.basename(configFile)}:${index + 1} 不是 KEY=VALUE，已跳过`);
      return;
    }
    const key = trimmed.slice(0, separator).trim();
    if (!key.startsWith("FENIX_FEATURE_")) return;
    const rawValue = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (rawValue !== "true" && rawValue !== "false") {
      warnings.push(`${key} 取值不是 true / false（${rawValue}），按未声明处理`);
      return;
    }
    values[key] = rawValue === "true";
  });

  return { source: path.relative(repoRoot, configFile).split(path.sep).join("/"), values, warnings };
}

/** 目录名 → 开关键：`sandbox-peri` → `FENIX_FEATURE_SANDBOX_PERI`。 */
export function flagForDirName(dirName: string): string {
  return `FENIX_FEATURE_${dirName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** compose profile 名 → 开关键：`mysql` → `FENIX_FEATURE_MYSQL`。 */
export function flagForProfile(profile: string): string {
  return flagForDirName(profile);
}

export function flagState(flags: FeatureFlags, flag: string | null): FeatureState {
  if (!flag) return "enabled";
  const value = flags.values[flag];
  if (value === undefined) return "unset";
  return value ? "enabled" : "disabled";
}
