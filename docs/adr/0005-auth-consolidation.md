# Auth Consolidation

合并 `auth/api-key.ts`（14 行 legacy 全局 key 校验）到 `auth/api-key-service.ts` 的验证链。删除已废弃的 `auth/middleware.ts`，引用迁移到 `authGuardPlugin`。统一 `ensureSystemUser()` 为 `plugins/auth.ts` 中的单一实现。`v1/session-ingress.ts` 改用 `authGuardPlugin` 的 `apiKeyAuth` macro，不再直接调用认证函数。

Status: accepted
