// web/i18n/index.ts
// chat 域命名空间的文案资源出口（键的最终所在地 = 包的 owner）。
//
// 宿主注册方式（apps/web/src/i18n/index.ts）：从子路径 `@fenix/agent-runtime/web/i18n` 导入本模块，把
// `agentChatResources.en/zh` 登记到 `AGENT_CHAT_NS`。走子路径而不是 `./web` 根入口——宿主 i18n 模块在应用
// 启动时就求值，从根入口导入会把整个聊天面板图（ACPMain、ui-components 的 chat 外壳）拉进首屏 bundle。
// 未注册时 i18next 回退为 key 回显，因此宿主接线必须先于消费方启用。
//
// 本字典自持键的来源（台账 `ce-standards-todo.md` D1）：聊天容器簇从宿主
// `apps/web/src/pages/agent-panel/` 迁入本包，键随实现换 owner——`agentPanel` 命名空间里的 11 条
// （面板欢迎/连接/断开/重连/发送失败文案）与宿主 `components` 命名空间的 `filePicker.title`，
// 在全仓只有迁走的那几个文件消费（逐键 grep 确认），故从宿主字典**删除**而不是复制：同键双份会在运行期
// 出现「哪一份生效」取决于登记顺序的静默分歧。

import en from "./locales/en/agentChat.json";
import zh from "./locales/zh/agentChat.json";

export { AGENT_CHAT_NS } from "./namespace";

/**
 * chat 域的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，由
 * `web/__tests__/agent-runtime-i18n.test.ts` 守护）。
 */
export const agentChatResources = { en, zh } as const;

export type AgentChatResources = typeof agentChatResources;
