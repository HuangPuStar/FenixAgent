# 实时完整对象的重试契约

`LiveWriter.accept({ kind: "content-object" })` 使用已有 `ProjectionStore`、写者租约和 `appendUpdates`，不创建另一条提交路径。

1. 稳定来源身份使用分片前的 `identityOf(normalizeMeta(meta))`，包含 kind、entryId、contentSlot、partIndex 和 sourceRevision；缺省值与显式零保持不同。同一身份的正文、分片方案和展示元数据不可改变，修改内容必须提供新 sourceRevision。
2. 每个物理分片通过 `live-object` ref 定位。正文 update、定位 ref 与原始字节摘要在一次 `appendUpdates` 中提交；额度拒绝不得留下 ref 或正文。recordId 同时绑定身份、完整对象摘要、分片位置及分片摘要，防止重试混入另一份内容或分片方案。
3. 重试先精确查询 ref，再读取目标 Doc 的已提交 canonical base 和连续 tail，核对记录身份与字节后跳过已提交片。未命中的片继续沿正常轮换路径提交。内容跨块、writer recover/reopen 和提交后回执丢失均按此规则处理，不保存第二份内存进度表。
4. 同身份异内容返回 `DIGEST_CONFLICT`；悬空、损坏或无法读取的定位不得当作成功。原始批次 digest 仍对应 Yjs update 字节，客户端摘要校验不变。
5. 多片实时对象必须提供稳定 entryId，否则在写入前返回 `MALFORMED_FRAME`。无 entryId 的单片对象不按正文去重，两次接收保留两份；历史批量导入的匿名对象规则保持原有契约。
6. `RefQuery` 同时提供 contentSlot 和 partIndex 时复用现有完整 Map 键精确读取，不扫描所有 refs；其他分页、limit 和 afterPartIndex 过滤保持一致。定位与正文的预算、退役、快照恢复均由已有 Store 生命周期管理。
