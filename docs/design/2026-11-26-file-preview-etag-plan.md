# 远程文件预览缓存修复计划

**目标：** 同大小文件保存后，新标签页和工具栏刷新读取最新正文。

**已确认方案：** 主服务复用远端现有 `stat`，用文件大小和毫秒修改时间校验缓存；不修改 acp-runtime，不为普通预览计算内容哈希。现有内容版本读取继续使用 SHA-256 契约。

**边界：** 授权仍经 Machine Facade；所有查询使用当前已授权环境和选定机器。数据库、前端交互和远端协议不变。元数据校验属于低成本变化探测，不能识别同大小且保留修改时间的外部写入；显式刷新必须绕过缓存。

## Task 1: 远程读取与 HTTP 缓存

涉及文件：`file-backends.ts` 负责读取前后 stat；`file-types.ts` 说明可靠修改时间语义；文件路由 `fs.ts` 负责缓存协议；新增 `fs-remote-etag.test.ts` 验证真实路由；`docs/arch/12-files.md` 更新稳定契约。

- [x] 先补失败测试：同大小文本/二进制保存后旧 ETag 必须返回 200；未变返回 304；旧 size-only ETag 失效；重复 `retry=1` 强制返回最新正文。
- [x] 补并发与失败测试：读取前后 mtime 或 size 变化、mtime 缺失时返回 200/no-store 且无 ETag；stat 失败保留错误；内容版本请求无需 stat；跨租户拒绝不触发远端调用；旧运行时报告大小与正文不符时禁用缓存。
- [x] 运行 `bun test packages/resources/machine/src/server/__tests__/fs-remote-etag.test.ts`，确认缓存行为断言失败。
- [x] 实现需要条件缓存的普通远程读取前后各一次 stat；只有前后均为普通文件、有效 mtime 相同且两次大小与实际正文字节数一致时携带 mtime。元数据不可靠时不生成 ETag，不返回 304。
- [x] 路由识别现有 `preview=true&retry=...` 刷新请求，返回 200/no-store；普通稳定响应继续 no-cache + ETag；内容版本读取保持原协议。强制刷新和外部 no-store 下载不额外查询 stat。
- [x] 运行新增测试及原有 fs-etag、fs-read-mode、file-content-version 测试，预期全绿。
- [x] 同步架构说明，运行 fastcheck、precheck；独立审查分支并通过回归测试验证审查修复。

**交付约定：** 将预览缓存修复与文件编辑提示、引用行号修复汇总到 `codex/fix-file-editing-feedback`，rebase 最新 `origin/main` 后创建 PR；保留主工作区的已有改动。

## 验证与回滚

回归测试替换 file-ws 传输与认证基础设施，运行真实 route → Facade → Service → RemoteBackend；不替换被修复的缓存判断。覆盖带 retry 和不带 retry 的独立缓存地址。全量验证以 `bun run precheck` 为准；本任务无前端与文档站点页面变更，不产生构建产物。

故障继续经现有文件错误映射和日志保留诊断上下文；无隐式重试。回滚可直接 revert 本任务提交，不涉及存量数据或迁移。
