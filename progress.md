# CRUD 业务逻辑层 Code Review 进度

## 2026-05-16 第一次审查

审查范围：src/services/config/*.ts, skill.ts, instance.ts, task.ts, scheduler.ts, session.ts, environment-*.ts

发现问题与修复：

1. **BUG — task.ts headers 双重编码**：`createTask`/`updateTask` 对 jsonb 列手动 `JSON.stringify`，导致 Drizzle 二次编码。新增 `parseHeaders()` 兼容旧数据（支持双重编码字符串自动解析）。移除手动序列化，由 Drizzle jsonb 列自动处理。
2. **BUG — task.ts 非空断言**：`updateTask` 和 `executeTaskById` 中 `row!` 强制断言改为 null 检查 + 返回 NOT_FOUND 错误。
3. **类��安全**：`environment-web.ts` 两处 `catch (err: any)` 改为 `catch (err: unknown)` + 类型收窄。
4. **日志缺失**：`instance.ts stopAllInstances` 空 catch 块添加错误日志。
5. **一致性**：`sanitizeTask`/`sanitizeExecutionLog` 时间戳统一使用 `toUnixTimestamp()`。

测试：新增 `task-headers.test.ts`（9 用例）+ `task-core.test.ts`（3 用例），全部通过。TypeScript 类型检查通过。

## 2026-05-16 第二次审查

审查范围：config/*.ts 验证函数、environment-core.ts、instance.ts、scheduler.ts

修复：
1. **BUG — toResponse 浮点时间戳**：`last_poll_at` 返回浮点秒数，改为 `Math.floor` 与 `sanitizeResponse` 一致。
2. **DRY — enterEnvironment 重复逻辑**：会话创建逻辑提取为复用 `findOrCreateForEnvironment`，消除 14 行重复代码。
3. **scheduler 日志修正**：移除 `rescheduleTask` 在 disabled 任务上打印 "Rescheduled" 的误导日志。
4. **测试覆盖**：新增 `config-validators.test.ts`（39 用例）覆盖 MCP/Agent/Workspace 全部纯验证函数。

待处理：~~provider/model/agent-config/mcp-server/user-config 中 jsonb 列存在与 task.ts 相同的手动 JSON.stringify 双重编码问题，需单独 PR 搭配迁移脚本。~~ 已在第三次审查中修复。

## 2026-05-16 第三次审查

审查范围：config 层 6 个文件的 jsonb 双重编码系统性修复

修复：
1. **BUG — 全量 jsonb 双重编码**：provider（extraOptions）、model（modalities/limitConfig/cost/options）、agent-config（permission/knowledge）、mcp-server（config/inputSchema）、user-config（permission）、skill（metadata）共 7 张表的 jsonb 列移除手动 `JSON.stringify`，共 16 处。
2. **新增 parseJsonb 工具**：`config/jsonb.ts` 提供向后兼容读取，自动处理旧双重编码数据和新正确编码数据。
3. **toServerInfo 安全读取**：改用 `parseJsonb` 解析 config 字段，消除 `as Record<string, unknown>` 类型欺骗。
4. **agent-config 简化**：create/update 字段遍历逻辑统一为 `val ?? null`，消除 if/else 分支。

测试：新增 `jsonb-utils.test.ts`（14 用例）。累计 3 轮新增 75 个测试用例。

## 2026-05-16 第四次审查

审查范围：task.ts、skill.ts、instance.ts、scheduler.ts 的 DRY 和代码清洁度

修复：
1. **DRY — task.ts parseHeaders**：复用 `parseJsonb` 消除 14 行重复解析逻辑，`executeTaskById` 统一使用 `parseHeaders`。
2. **DRY — skill.ts**：移除 4 个未使用的 import，提取 `stripNameAndDescription` 消除 2 处重复 metadata 过滤。
3. **DRY — instance.ts**：提取 `filterInstances` 辅助函数，3 个列表函数共用（减少约 30 行），清理多余注释分隔符。
4. **scheduler.ts**：`scheduleTask` 的 nextRunAt 更新从静默吞错改为 error 日志。
5. **jsonb-utils.test.ts 类型修复**：补充泛型参数消除 TypeScript `toBe` 重载歧义。

净减少 26 行代码，TypeScript 类型检查通过，62 个测试全部通过。

## 2026-05-16 第五次审查

审查范围：mcp-server.ts、instance.ts、skill.ts 的遗漏问题和类型安全

修复：
1. **BUG — updateMcpServer 遗漏 JSON.stringify**：第三轮修复 createMcpServer 时漏掉了 update 路径，config 字段仍双重编码。
2. **类型安全 — toSpawnedInstance**：pluginMetadata 中的 port/pid/token 从 `as` 断言改为 `typeof` 守卫，防止外部输入类型不匹配。
3. **类型安全 — agentConfig 字段**：prompt/model 提取改用 `typeof === "string"` 守卫。
4. **mcp-server toServerInfo**：移除冗余的 `as Record<string, unknown>` 转换。
5. **skill.ts 清理日志**：importSkillDirectories 错误回滚的空 catch 改为 console.error。

测试：新增 `instance-meta.test.ts`（13 用例）。5 轮累计新增 88 个测试用例。

## 2026-05-17 第六次审查

审查范围：environment-web.ts、task.ts、skill.ts、instance.ts、environment-acp.ts

修复：
1. **null 安全** — `updateWebEnvironment` 更新后 re-fetch 添加 null 检查，未找到时抛 NotFoundError。
2. **日志规范** — `executeTaskById` catch 块补充 `logError`；`skill.ts` 的 `console.log`/`console.error` 统一替换为 logger 模块；`stopInstance` 成功路径补充日志；`registerBridge` authEnvironmentId 未找到时补充 warning。
3. **测试** — 新增 `task-validators.test.ts`（20 用例）覆盖 validateCron/normalizeTimezone/validateTaskInput；新增 `environment-core-utils.test.ts`（7 用例）覆盖 generateEnvSecret/toResponse/sanitizeResponse。6 轮累计 115 个测试用例。

## 2026-05-17 第七次审查

审查范围：全量 CRUD 层（config/*.ts、task、scheduler、skill、instance、session、environment）

修复：
1. **性能** — `countToolsByServer` 改用 SQL COUNT 聚合，避免全量 SELECT。
2. **原子性** — `replaceToolsForServer` 用 `db.transaction()` 包裹 delete+insert。
3. **DRY** — `executeTaskById` 提取 `writeLogAndReturn` 消除成功/错误路径重复代码，净减 16 行。
4. **类型安全** — `validateAgentData` 移除 5 处 `as` 断言，先 typeof 守卫再使用。
5. **内存泄漏** — `unscheduleTask` 同时清理 `runningTasks` 残留。
6. **可观测性** — `migrateSkillsDir` rename 失败补充日志。
7. 新增 `build-model-data.test.ts`（10 用例），`config-validators.test.ts` 新增 5 用例。7 轮累计 130 个测试。

## 2026-05-17 第八次审查

审查范围：environment-acp.ts、config/provider.ts、config/aggregate.ts、config/mcp-server.ts

修复：
1. **null 语义** — `capabilities || null` 改为 `?? null`（3 处），精确表达 nullish 语义，避免未来 falsy 值被意外吞掉。
2. **BUG — buildModelData null 透传**：falsy 检查改为 `!== undefined`，允许前端显式传 `null` 清除 modalities/cost 等字段。
3. **BUG — getAgentFullConfig skills 丢失**：agentConfig 不存在时回退全局 skills，而非返回空数组。
4. **类型安全 — toServerInfo command 守卫**：`config.command` 添加 `Array.isArray` 检查，防止非数组输入导致崩溃。
5. 新增 `mcp-server-info.test.ts`（7 用例）、`capabilities-coalescing.test.ts`（5 用例），更新 `build-model-data.test.ts`。8 轮累计 143 个测试。

## 2026-05-17 第九次审查

审查范围：全量 CRUD 层（task、skill、instance、environment-acp）

修复：
1. **死字段清理** — 移除 `TaskExecutionLogResponse.statusCode`（DB 无此列、前端未使用、始终为 null）。
2. **日志一致性** — `stopInstance` catch 块补充 `logError`，与 `stopAllInstances` 行为对齐。
3. **null 语义遗漏** — `registerBridge` 中 `capabilities || undefined` 改为 `?? undefined`（第8轮遗漏的最后一处）。
4. **废弃导入** — `migrateSkillsDir` 移除未使用的 `mkdtemp`、`tmpdir` 动态导入。
5. 新增 `sanitize-execution-log.test.ts`（3 用例）。9 轮累计 146 个测试。

## 2026-05-17 第十次审查

审查范围：全量 CRUD 层深度审计（含 launch-spec-builder、config 子目录）

修复（4 BUG + 4 WARNING）：
1. **BUG — skill scope 泄漏**：`enableSkill`/`disableSkill` 缺少 `isNull(environmentId)` 条件，全局 skill 操作会误改同名 workspace skill。
2. **BUG — fetch 无超时**：`executeTaskById` 的 `fetch()` 添加 `AbortSignal.timeout(30_000)`，防止慢速目标阻塞 scheduler。
3. **BUG — 空 method 绕过校验**：`validateTaskInput` 对空字符串 method 从默放行改为拒绝（`data.method !== undefined` + trim 检查）。
4. **BUG — JSON.parse 崩溃**：`launch-spec-builder.ts` MCP config 解析添加 try-catch，无效 JSON 跳过而非崩溃。
5. **WARNING — 分页边界**：`listExecutionLogs` 添加 page≥1、pageSize 1-100 钳位。
6. **WARNING — type 列过时**：`updateMcpServer` 同步更新 `type` 列（从 `config.type` 推导）。
7. **WARNING — 定时器泄漏**：`listSkillSources` 添加 `clearTimeout` 防止悬挂定时器。
8. **WARNING — 变量遮蔽**：`skill.ts` 两处 `catch (error)` → `catch (err)`，消除与 logger 导入的命名混淆。
9. 新增 `pagination-bounds.test.ts`（6 用例），`task-validators.test.ts` 新增 2 用例。10 轮累计 153 个测试。

## 2026-05-17 第十一次审查

审查范围：全量 CRUD 层 + config 子目录类型安全审计

修复（4 WARNING + 4 CLEANUP）：
1. **WARNING — filterInstances 并发安全**：`instance.ts` 的 `filterInstances` 从 `.filter().map(!)` 改为 `.flatMap()`，消除 concurrent `stopAllInstances` 导致的 `!` 断言失败风险。
2. **WARNING — listSkillSources 错误误标**：非超时拒绝（权限/ENOENT 等）从统一标为 `"timeout"` 改为区分 `"timeout"` 和 `"offline"`。
3. **WARNING — toServerInfo streamable-http**：`mcp-server.ts` 的 `toServerInfo` 新增 `streamable-http` 类型识别，不再误归为 `remote`。
4. **WARNING — writeLogAndReturn 二次查询**：`task.ts` 的 `writeLogAndReturn` 从 create 后 re-read 改为直接从参数构造响应，消除 create→getById 不一致风险。
5. **CLEANUP — validateTaskInput 冗余**：`task.ts` 合并 6 处重复 name/url 检查为统一模式（先 `undefined` 检查再必填检查）。
6. **CLEANUP — registerEnvironment 类型欺骗**：`environment-acp.ts` 移除 `as "active"` 强制转换，使用实际 record.status。
7. **CLEANUP — Record<string, unknown> 类型安全**：`user-config.ts` 和 `model.ts` 的 `values`/`set` 变量从 `Record<string, unknown>` 改为 `Partial<...$inferInsert>`，移除 `as` 断言。
8. 新增 `skill-source-error-status.test.ts`（5 用例），`mcp-server-info.test.ts` 新增 3 用例，`task-validators.test.ts` 新增 3 用例。11 轮累计 164 个测试。

## 2026-05-17 第十二次审查

审查范围：全量 CRUD 层 Record<string,unknown> 类型安全收尾 + environment-core 时间戳一致性

修复（1 BUG + 5 CLEANUP）：
1. **BUG — sanitizeResponse 冗余 Date 包装**：`environment-core.ts` 的 `sanitizeResponse` 对已是 Date 的字段调用 `new Date(row.createdAt)`，���为直接 `.getTime()`，与 `toResponse` 行为对齐，消除无意义的对象创建。
2. **CLEANUP — agent-config 类型安全**：`createAgentConfig`/`updateAgentConfig` 的 `values`/`set` 从 `Record<string, unknown>` 改为 `Partial<...$inferInsert>`。
3. **CLEANUP — updateWebEnvironment patch 类型**：从 `Record<string, unknown>` 改为 `EnvironmentUpdateParams`。
4. **CLEANUP — updateTask updates 类型**：从 `Record<string, unknown>` 改为 `Partial<ScheduledTaskInsert>`。
5. **CLEANUP — updateMcpServer updates 类型**：从 `Record<string, unknown>` 改为 `Partial<...$inferInsert>`。
6. **测试** — 新增 `agent-config-validators.test.ts`（19 用例）覆盖 validateAgentData/isBuiltInAgent/toolsToPermission/AGENT_SETTABLE_FIELDS；`environment-core-utils.test.ts` 新增 1 用例验证毫秒精度。确认 `top_p` vs `topP` 命名不匹配为已知问题。12 轮累计 172 个测试。

## 2026-05-17 第十三次审查

审查范围：全量 CRUD 层最终精细审计

修复（2 BUG + 1 CLEANUP）：
1. **BUG — writeLogAndReturn 错误码语义错误**：`task.ts` 执行日志写入失败返回 `"NOT_FOUND"`，改为 `"WRITE_ERROR"`，新增 `WRITE_ERROR` 错误码。
2. **BUG — deleteSkill 删除顺序不安全**：`skill.ts` 先删文件再删 DB 记录，若 DB 删除失败则文件已丢失。改为 DB-first + 文件清理容错（catch 不抛出）。
3. **测试** — 新增 `task-utils-edge-cases.test.ts`（10 用例）覆盖 `truncateSummary`（空串/null/2000边界/unicode）和 `toUnixTimestamp`（null/毫秒截断/epoch零点）。13 轮累计 182 个测试���
