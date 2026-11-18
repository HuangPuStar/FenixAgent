# 实时完整对象的重试契约

`LiveWriter.accept({ kind: "content-object" })` 使用已有 `ProjectionStore`、写者租约和 `appendUpdates`，不创建另一条提交路径。

1. 稳定来源身份使用分片前的 `identityOf(normalizeMeta(meta))`，包含 kind、entryId、contentSlot、partIndex 和 sourceRevision；缺省值与显式零保持不同。同一身份的正文、分片方案和展示元数据不可改变，修改内容必须提供新 sourceRevision。
2. 每个物理分片通过 `live-object` ref 定位。正文 update、定位 ref 与原始字节摘要在一次 `appendUpdates` 中提交；额度拒绝不得留下 ref 或正文。recordId 同时绑定身份、完整对象摘要、分片位置及分片摘要，防止重试混入另一份内容或分片方案。
3. 重试先精确查询 ref，再读取目标 Doc 的已提交 canonical base 和连续 tail，核对记录身份与字节后跳过已提交片。未命中的片继续沿正常轮换路径提交。内容跨块、writer recover/reopen 和提交后回执丢失均按此规则处理，不保存第二份内存进度表。
4. 同身份异内容返回 `DIGEST_CONFLICT`；悬空、损坏或无法读取的定位不得当作成功。原始批次 digest 仍对应 Yjs update 字节，客户端摘要校验不变。
5. 多片实时对象必须提供稳定 entryId，否则在写入前返回 `MALFORMED_FRAME`。无 entryId 的单片对象不按正文去重，两次接收保留两份；历史批量导入的匿名对象规则保持原有契约。
6. `RefQuery` 同时提供 contentSlot 和 partIndex 时复用现有完整 Map 键精确读取，不扫描所有 refs；其他分页、limit 和 afterPartIndex 过滤保持一致。定位与正文的预算、退役、快照恢复均由已有 Store 生命周期管理。

## 额度与轮换恢复

- 更新账本追加保留已有记录、字节缓冲及其 reservations，仅为新增保留数据取得增量额度。替换数组的临时头部与旧前缀指针空间在构造前取得 `controlIndex` 额度；整批准备失败只退还新增和临时额度，原账本、refs 与批次均不改变。普通 Map 替换仍按完整新值预留，不能推测任意替换共享旧内存。
- `readSuccessor(scopeKey, docId)` 返回已提交的文档生命周期与唯一路由。已知文档但无路由与未知/退役文档分别表达；恢复检查 scope、generation、kind、目标存在性与循环，临时遍历集合使用受预算约束的 `controlIndex`。
- 停在 sealing 时，恢复使用已登记目标的同一份 base 字节和固定截止序号完成封口；已 sealed 时直接跟随既有路由。内容目录按链顺序补齐发布，全部成功后才交付 active 写入点，再次拒绝保持显式失败。
- runtime 活动实体进入 successor 初始快照后才发布路由，取消封口后的独立搬运窗口。恢复追随 runtime 路由；没有后续更新且初次交接未完成的空后继可以补齐一次，已有后续更新的后继不得重新复制旧实体，避免复活已完成工具。
- 全片命中的重试在最后读取后复核 scope 的 currentGeneration、owner、epoch 和租约期限。单次对象重试仅缓存当前一个已提交 Doc，离开该块、追加和退出时销毁缓存。
- 目录初始化先登记全部页，再发布根目录；目录翻页发布被拒后复用已登记页的 canonical 字节与 lastSeq。重试必须校验其逻辑页内容一致，不能为同一 pageId 重新生成另一份 Yjs 身份，也不能用未完成的根入口确认目录就绪。
