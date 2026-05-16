# Environment Service 三文件拆分

Environment service 按关注点拆分为三个文件：`environment-core.ts`（共享工具和 repo 封装）、`environment-acp.ts`（ACP 协议和 bridge 注册生命周期）、`environment-web.ts`（Web 控制面板 CRUD）。三个文件互不直接调用（acp 和 web 只依赖 core），调用者群（transport/v1 vs web routes）完全不重叠。

拆分经过深度分析确认：ACP 协议变更只影响 acp.ts，Web UI 变更只影响 web.ts，共享逻辑（路径校验、响应格式化）集中在 core.ts。合并为单文件会导致 500+ 行且修改局部性下降。

Status: accepted
