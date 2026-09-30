/**
 * 领域服务侧接受的「远端凭据」端口。
 *
 * 知识库领域服务需要 RAGFlow key 才能访问远端，但**解析身份与解析时机都不属于它**：身份由门面从已认证
 * actor 固定（调用者，不是知识库属主或请求参数），时机由各动作的分支语义决定——删除未同步的知识库、
 * 刷新远端失败退回本地缓存这两条路径在迁移前根本不解析凭据，若门面提前解析会把它们变成失败。
 *
 * 因此这里传的是**取值动作**而不是解析好的字符串：领域服务决定「什么时候取」，门面固定「用谁的身份取」。
 * 端口声明在服务侧（而不是门面侧）是为了让依赖方向保持 `facade → service`：服务只依赖这个不含身份信息的
 * 类型，门面与路由各自从自己的层引用它。
 *
 * ## 与迁移前的时机差异（2026-09-25 收口时登记，非逐条等价）
 *
 * 迁移前 `knowledge-upload` 的 `resolveKb` 把「组织校验 + 凭据解析」捆在一次解析里，`kb.remoteId` 的判断在
 * 它之后，于是凭据**先于**远端定位校验发生。上移门面后凭据改为惰性，以下三处因此与迁移前不同（三处都只在
 * **RAGFlow 未配置**的部署里可观察到；配置齐全时取值动作不改变结果）：
 *
 * - `uploadKnowledgeResource`（`services/knowledge-upload.ts`）：`!kb.remoteId` 的判定提到取凭据之前。
 *   RAGFlow 未配置且知识库未同步远端时：迁移前 400 `VALIDATION_ERROR`（"RAGFLOW_API_KEY is not configured"），
 *   现在 404 `NOT_FOUND`（"知识库 remoteId 不存在"）。
 * - `importKnowledgeResourceFromUrl`（同文件）：同上。
 * - `deleteKnowledgeResource`（同文件）：只在资源存在 `remoteId` 时才取凭据。RAGFlow 未配置时删除**无远端文档**
 *   的本地资源：迁移前 400 失败，现在成功（放宽的是远端配置前置条件，不是授权判定——归属校验仍先于它执行）。
 *
 * 这三处是惰性凭据的必然结果而不是疏漏；若要恢复逐条等价，把三处的取值动作提到相应的 `remoteId` 判断之前即可。
 */
export type KnowledgeBaseCredential = () => Promise<string>;
