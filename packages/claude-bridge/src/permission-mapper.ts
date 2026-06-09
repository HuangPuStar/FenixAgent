import type { AgentLaunchSpec } from "@fenix/plugin-sdk";

/**
 * RCS 三态 permission → Claude SDK 六态 permissionMode 映射：
 *   ask   → "default"
 *   allow → "acceptEdits"
 *   deny  → "dontAsk"
 */
export function mapPermissionToSdkMode(permission: string): string {
  switch (permission) {
    case "ask":
      return "default";
    case "allow":
      return "acceptEdits";
    case "deny":
      return "dontAsk";
    default:
      return "default";
  }
}

/**
 * 从 AgentLaunchSpec 中提取 allow/deny 规则，
 * 转换为 Claude Code CLI settings.json 的 permissions 格式。
 */
export function mapPermissionsToClaudeSettings(_launchSpec: AgentLaunchSpec): { allow?: string[]; deny?: string[] } {
  // Claude Code CLI settings.json 支持 permissions.allow / permissions.deny 字符串数组
  // 当前从 launchSpec 的 permission 配置中提取规则型工具的 allow/deny 列表
  // 具体实现取决于 permission 的数据结构
  return {};
}
