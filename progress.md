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

## 2026-05-17 第十四次审查

审查范围：全量 CRUD 层 streamable-http 验证缺口、错误类一致性、类型安全收尾

修复（1 BUG + 3 CLEANUP）：
1. **BUG — validateMcpConfig 拒绝 streamable-http**：`mcp-server.ts` 的 `validateMcpConfig` 仅接受 local/remote，但 `toServerInfo` 已支持 streamable-http，导致通过验证���创建 streamable-http 类型 MCP 服务器时静默失败。修复为 streamable-http 与 remote 共享 url 校验规则。
2. **CLEANUP — Object.assign 错误 → AppError**：`instance.ts`（enterEnvironment）和 `environment-acp.ts`（handleAcpIdentify）共 3 处 `Object.assign(new Error, { code })` 替换为标准 `NotFoundError`/`AppError`，与路由层 `err.code` 检查兼容。
3. **CLEANUP — buildModelData 类型守卫**：`provider.ts` 的 `data.name as string` 改为 `typeof data.name === "string"` 守卫，非字符串 name 不映射。
4. **CLEANUP — listSkillSources timer 初始化**：`skill.ts` 的 `timer` 变量从 `!` 断言改为 `| undefined` 初始化 + `if` 检查。
5. 新增 `error-class-semantics.test.ts`（3 用例），`config-validators.test.ts` 新增 3 用例（streamable-http），`build-model-data.test.ts` 新增 1 用例（非字符串 name）。14 轮累计 189 个测试。

## 2026-05-17 第十五次审查

审查范围：instance 错误传播链路、task 冗余操作、scheduler 容错

修复（1 BUG + 3 CLEANUP）：
1. **BUG — instances.ts 路由错误码路由失效**：`spawnInstanceFromEnvironment` 路由通过 `err.message` 字符串匹配 HTTP status，但 workspace 路径错误消息不匹配（"does not exist" vs "not set"），导致始终返回 500。改为 code-based routing：`spawnInstanceFromEnvironment` 抛出 `NotFoundError`/`AppError(FORBIDDEN/VALIDATION_ERROR/MAX_SESSIONS_REACHED)`，路由层用 `err.code` 映射 status。
2. **CLEANUP — writeLogAndReturn 双重截断**：`task.ts` 的 `writeLogAndReturn` 对 `resultSummary` 调用 `truncateSummary`，但 2 个调用方已截断。移除冗余调用。
3. **CLEANUP — stopScheduler 容错**：`scheduler.ts` 的 `job.cancel()` 包裹 try-catch，避免单个 job 取消失败阻断后续清理。
4. 新增 `instance-error-codes.test.ts`（6 用例）覆盖 code→status 映射。15 轮累计 195 个测试。

## 2026-05-17 第十六次审查

审查范围：task TOCTOU、skill rollback 容错

修复（1 CLEANUP + 1 WARNING）：
1. **CLEANUP — deleteTask 双查询 → 单查询**：`task.ts` 的 `deleteTask` 从 `existsByUserAndId` + `deleteByUserAndId`（2次DB查询）简化为单次 `deleteByUserAndId`（已有 userId WHERE + returning 判断），消除 TOCTOU 竞态窗口。
2. **WARNING — importWorkspaceSkillDirectories 回滚错误掩盖**：`skill.ts` 的 workspace import 回滚路径中 `cleanupWrittenSkills`/`restoreFromBackup` 若抛出异常会掩盖原始错误。包裹 try-catch + logError。
3. 新增 `delete-task-toctou.test.ts`（4 用例）覆盖单查询删除逻辑。16 轮累计 199 个测试。

## 2026-05-17 第十七次审查

审查范围：全量 CRUD 层（task、environment-acp、skill、instance）

修复（1 BUG + 3 WARNING + 1 CLEANUP）：
1. **BUG — writeLogAndReturn 重复日志**：`task.ts` 的 `scheduledTaskRepo.update` 未 try-catch，失败时异常冒泡到 `executeTaskById` 的 catch 块，导致重复写入 "failed" 日志条目。
2. **WARNING — registerBridge 越权**：`environment-acp.ts` 收到 `authEnvironmentId` 时未校验 `existing.userId === userId`，可跨用户重新激活环境。
3. **WARNING — importSkillDirectories rollback 错误掩盖**：全局导入的 rollback 路径 `cleanupWrittenSkills`/`restoreFromBackup` 未 try-catch（R16 只修了 workspace 变体）。
4. **WARNING — stopInstance 二次 stop**：`instance.ts` 仅检查 `"stopped"` 状态，对 `"stopping"` 仍尝试 stop。
5. 新增 `write-log-no-duplicate.test.ts`（3 用例）、`register-bridge-ownership.test.ts`（5 用例）。17 轮累计 207 个测试。

## 2026-05-17 第十八次审查

审查范围：全量 CRUD 层（instance、skill、task、config/aggregate）

修复（2 WARNING + 1 DRY + 1 CLEANUP）：
1. **WARNING — stopAllInstances stopping 状态**：`instance.ts` 的 `stopAllInstances` 仅跳过 `"stopped"`，未跳过 `"stopping"`（R17 修复了 `stopInstance` 但遗漏此处）。
2. **WARNING — setSkill 部分写入**：`skill.ts` 文件写入成功后 PG upsert 失败时清理孤儿文件，包裹 try-catch 回滚。
3. **DRY — aggregate.ts 重复查询**：全局 skills 查询提取 `listGlobalSkills` 辅助函数，消除两处重复。
4. **CLEANUP — getTaskById 返回类型**：`task.ts` 补充 `Promise<ScheduledTaskRow | null>` 显式返回类型。
5. 新增 `set-skill-rollback.test.ts`（3 用例）、`stop-all-instances-stopping.test.ts`（4 用例）。18 轮累计 214 个测试。

## 2026-05-17 第十九次审查

审查范围：全量 CRUD 层（task、scheduler、instance）

修复（1 WARNING + 2 CLEANUP）：
1. **WARNING — executeTaskById timeout 状态区分**：`task.ts` 检测 `AbortSignal.timeout` 触发的 `AbortError`，状态标为 `"timeout"` 而非 `"failed"`。
2. **CLEANUP — scheduler skipped 分支容错**：`scheduler.ts` `executeTask` 的 skipped 分支 DB 操作包裹 try-catch，失败不再冒泡。
3. **CLEANUP — enterEnvironment 死代码**：移除不可达的 `if (!inst)` 防御检查。
4. 新增 `task-timeout-status.test.ts`（3 用例）。19 轮累计 217 个测试。

## 2026-05-17 第二十次审查

审查范围：全量 CRUD 层（aggregate、task、instance、scheduler、session、environment）

修复（1 PERFORMANCE + 1 WARNING + 1 CLEANUP）：
1. **PERFORMANCE — aggregate.ts 查询并行化**：`getAgentFullConfig` 在无 agentConfigId 时 3 路并行（原 2+1），有 agentConfigId 时 providers/mcpServers/agentConfig 3 路并行（原 3 阶段串行变 2 阶段），减少 spawn 延迟。
2. **WARNING — task.ts Content-Type 大小写不敏感**：`executeTaskById` 检查 `headers["Content-Type"]` 改为 `Object.keys().some(k => k.toLowerCase() === "content-type")`，避免用户传 `content-type` 小写时重复添加 header。
3. **CLEANUP — task.ts triggerTask 双查询优化**：`executeTaskById` 新增 `prefetchedTask` 可选参数，`triggerTask` 直接传入已获取的 task 数据，消除冗余 DB 查询。
4. 新增 `aggregate-parallel-queries.test.ts`（3 用例）、`task-prefetch-content-type.test.ts`（7 用例）。20 轮累计 227 个测试。

## 2026-05-17 第二十一次审查

审查范围：全量 CRUD 层 + repositories/task.ts

修复（2 PERFORMANCE + 1 CLEANUP + 1 DEAD IMPORT）：
1. **PERFORMANCE — scheduler.ts executeTask 传递 prefetchedTask**：`executeTask` 将已获取的 task 传给 `executeTaskById(taskId, "cron", task)`，消除每次 cron 触发的冗余 DB 查询。
2. **PERFORMANCE — task.ts updateTask 三重→双重查询**：`scheduledTaskRepo.update` 改用 `.returning()` 返回更新行，`updateTask` 直接使用返回值，省去单独的 `getById` 调用。
3. **PERFORMANCE — skill.ts listSkillSources 并行查询**：`listSkills` 和 `environmentRepo.listByUserId` 从串行改为 `Promise.all` 并行。
4. **DEAD IMPORT — environment-web.ts 移除未使用的 `randomBytes` import**。
5. 新增 `scheduler-prefetch.test.ts`（3 用例）、`update-task-no-requery.test.ts`（3 用例）。21 轮累计 233 个测试。

## 2026-05-17 第二十二次审查

审查范围：全量 CRUD 层（config 子目录、task、mcp-server、provider、user-config）

修复（2 BUG + 1 WARNING + 1 CLEANUP）：
1. **BUG — provider.ts upsertProvider TOCTOU**：SELECT+INSERT/UPDATE 竞态改为 `onConflictDoUpdate` 原子操作，消除并发创建同名 provider 时的 unique violation 错误（2-3 查询→1 查询）。
2. **BUG — user-config.ts setUserConfig TOCTOU**：同上，SELECT+INSERT/UPDATE 改为 `onConflictDoUpdate`（2 查询→1 查询）。
3. **WARNING — mcp-server.ts updateMcpServer 未校验 type**：`config.type` 从任意字符串改为 `VALID_MCP_TYPES` 白名单校验，防止无效类型写入 DB。
4. **CLEANUP — task.ts validateTaskInput 泛型签名**：参数从 `CreateTaskInput` 改为 `Partial<CreateTaskInput>`，消除 `updateTask` 中的 `as CreateTaskInput` 类型断言。
5. 新增 `mcp-server-type-validation.test.ts`（7 用例）、`validate-task-partial.test.ts`（6 用例）。22 轮累计 246 个测试。

## 2026-05-17 第二十三次审查

审查范围：全量 CRUD 层（scheduler、instance、config/skill、config/model）

修复（2 PERF + 1 DRY + 1 CLEANUP）：
1. **PERF — instance.ts ensureRunning 双查询消除**：`spawnInstanceFromEnvironment` 新增 `prefetchedEnv` 可选参数，`ensureRunning` 传入已获取的 env 记录，避免同一 environment 重复 DB 查询。
2. **PERF — config/model.ts addModel 原子化 upsert**：从原始 INSERT 改为 `onConflictDoUpdate`，利用 `idx_model_provider_model` uniqueIndex 实现幂等操作，消除并发重复 model 导致的 unique violation 错误。
3. **DRY — config/skill.ts upsertSkill 字段映射合并**：提取 `commonFields` 消除 insert/update 路径的重复字段映射（description/contentPath/metadata/enabled/agentConfigId/updatedAt）。
4. **CLEANUP — scheduler.ts 冗余表达式**：移除 `task ?? undefined`（null check 后 `task` 必然非空）。
5. 新增 `instance-prefetch-env.test.ts`（4 用例）、`model-upsert-conflict.test.ts`（5 用例）。23 轮累计 255 个测试。

## 2026-05-17 第二十四次审查

审查范围：全量 CRUD 层（config/mcp-server、config/agent-config、skill、session）

修复（2 BUG + 1 PERF + 1 CLEANUP）：
1. **BUG — config/mcp-server.ts createMcpServer TOCTOU**：原始 INSERT 改为 `onConflictDoUpdate`，利用 `idx_mcp_server_user_name` uniqueIndex 消除并发注册同名 MCP 的 unique violation。
2. **BUG — config/agent-config.ts createAgentConfig TOCTOU**：同上，利用 `idx_agent_config_user_name` uniqueIndex 实现原子 upsert。
3. **PERF — skill.ts importSkillDirectories N+1**：冲突检测循环中 `getSkill` 从串行改为 `Promise.all` 并行查询。
4. **CLEANUP — session.ts 不必要 async**：`getSession`/`resolveExistingSessionId`/`createSession` 移除 `async` 关键字，改为显式 `Promise.resolve`。
5. 新增 `mcp-agent-config-upsert.test.ts`（6 用例）、`session-sync-functions.test.ts`（5 用例）。24 轮累计 266 个测试。
