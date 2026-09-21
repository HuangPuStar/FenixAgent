import { AgentSitesCard } from "@fenix/agent-config/web";
import { registerTagRenderer } from "@fenix/ui-components/lib/card-renderer";
import type { ComponentType } from "react";

// 注册目标是 **ui-components 的注册表**，不是本目录的 `./registry`：
// markdown 渲染器已归 `@fenix/ui-components`（`web/chat/primitives/message.tsx` 读的是包内注册表），
// 只在宿主注册表登记会让 `agent-sites` 卡片在白名单外被 rehype-sanitize 剥离（助手回复里的站点卡片
// 连同「查看站点」入口一起消失，而 skill 文档要求建站结果只能经该卡片告知用户）。
// 宿主注册表与包内注册表是两份互不相通的模块实例；本目录原与包内 `web/lib/card-renderer` 重复的
// `registry` / `emitter` / `context` 属宿主死副本，已随 §1.6 T8z 删除，只剩本文件这一个注册入口。
registerTagRenderer("agent-sites", {
  component: AgentSitesCard as unknown as ComponentType<Record<string, unknown>>,
  allowedAttrs: ["agent-site-id", "url"],
});
