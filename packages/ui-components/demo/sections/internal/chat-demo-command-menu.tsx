/**
 * chat 分区示例：命令菜单元件（CommandMenu 独立形态）。
 *
 * 源实现里命令菜单由 ChatComposer 内部装配（filter 随草稿变化，选中即插入草稿）；这里单独渲染，
 * 是为了看清组件的完整接口面 —— 宿主需要注入 `onSelect` / `onToggleMcp` / `onClose` 三个回调，
 * 以及 `filter` 这一受控过滤词。
 *
 * 数据取包内 mocks 的 `MOCK_AVAILABLE_COMMANDS` / `MOCK_BOUND_MCPS`，零网络、零 YJS。
 */

import { type AvailableCommand, CommandMenu, type McpOption } from "@fenix/ui-components";
import { MOCK_AVAILABLE_COMMANDS, MOCK_BOUND_MCPS } from "@fenix/ui-components/chat/mocks/mock-fixtures";
import { useState } from "react";

/** 命令菜单示例组。 */
export function ChatCommandMenuExamples() {
  const [selectedCommand, setSelectedCommand] = useState<AvailableCommand | null>(null);
  const [selectedMcp, setSelectedMcp] = useState<McpOption | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="demo-example">
      <h2 className="demo-example-title">CommandMenu（独立形态）</h2>
      <CommandMenu
        commands={MOCK_AVAILABLE_COMMANDS}
        mcps={MOCK_BOUND_MCPS}
        filter=""
        onSelect={(command) => setSelectedCommand(command)}
        onToggleMcp={(mcp) => setSelectedMcp(mcp)}
        onClose={() => setNotice("命令菜单已关闭")}
      />
      <p className="demo-hint">
        {selectedCommand ? `已选命令：/${selectedCommand.name}` : "点命令即回调 onSelect；MCP 行为开关切换。"}
        {selectedMcp ? `（最近切换：${selectedMcp.name}）` : ""}
      </p>
      <p className="demo-hint">{notice ?? "等待交互…"}</p>
    </div>
  );
}
