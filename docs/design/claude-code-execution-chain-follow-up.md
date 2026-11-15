# 待处理：Claude Code 本地执行链

状态：已记录，本次临时环境功能不处理。

代码核实位置：`packages/plugin-claude-code/src/runtime/claude-code-runtime.ts`。

1. `startInstance` 当前执行 `spawn("acp-link", [])`，需要单独核实实际安装产物及启动参数能否建立预期的 Claude ACP 连接。
2. `connectRelay` 当前仅向本地 listeners 回传输入消息，未接通真实 Claude ACP 消息链，不能将其作为已验证的本地 SDK 聊天能力。
3. `stopInstance` 当前发送 SIGTERM 后删除本地记录，退出确认及失败处理应随执行链修复一起评估。

影响：这些是普通与临时环境共用的现有引擎实现问题；临时环境的创建、续期和目录准备不修复该链路。

后续独立任务应复用现有 InstanceManager、ClaudeCodeHandler 与 AcpDispatcher，验证真实 prompt、工具调用、取消、续聊和进程停止。未经该验证，不宣称本地 Claude 执行链已修复。四个引擎的 HOME／配置／历史隔离也不在本次范围内。
