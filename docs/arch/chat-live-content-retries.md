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
- 新后继的初始文档、空账本和唯一路由通过 `registerSuccessor({ successorDoc })` 一次取得额度并提交；确定拒绝时不留下孤立文档，未知结果则依赖同键查询和重试，不能推测未提交后回收。已预登记目标仍可独立登记路由。
- 匹配既有路由的重放仍须核对提供的身份与目标不可变的初始 base 字节，不能拿当前 final 快照代替初始 base；目标缺失时原子补齐文档与空账本，额度拒绝保留固定路由。复用预登记目标保留请求无法表达的 ordinals、依赖等元数据，不改写既有文档或更新账本。
- 封口时保留原始 base 快照及其额度，仅为新的 final 快照和替换元数据取得额度；准备失败保留原文档、指针与全部原额度，成功后释放被替换部分，退役或逐出时统一归还。
- `readSuccessor(scopeKey, docId)` 返回已提交的文档生命周期与唯一路由。已知文档但无路由与未知/退役文档分别表达；恢复检查 scope、generation、kind、目标存在性与循环，固定内存只读预检排除循环，每次访问借用并释放一份 `controlIndex`，不保留全链访问集合。
- 停在 sealing 时，恢复使用已登记目标的同一份 base 字节和固定截止序号完成封口；已 sealed 时直接跟随既有路由。内容目录按链顺序补齐发布，全部成功后才交付 active 写入点，再次拒绝保持显式失败。
- runtime 活动实体进入 successor 初始快照后才发布路由，取消封口后的独立搬运窗口。恢复先探测一条 successor 已提交更新，有更新就跳过两代文档重建；没有后续更新且初次交接未完成的空后继可以补齐一次，已有后续更新的后继不得重新复制旧实体，避免复活已完成工具。
- 全片命中的重试在最后片校验后调用 `Store.confirmWriter(lease, generation)`，在与换代、写权交接串行的单一 Store 点复核 currentGeneration、owner、epoch 和租约期限；成功确认的是该点的已提交事实，不依赖异步指针快照。单次对象重试仅缓存当前一个已提交 Doc，离开该块、追加和退出时销毁缓存。
- 目录初始化先登记全部页，再发布根目录；目录翻页发布被拒后复用已登记页的 canonical 字节与 lastSeq。重试必须校验其逻辑页内容一致，不能为同一 pageId 重新生成另一份 Yjs 身份，也不能用未完成的根入口确认目录就绪。

- 普通租约过期拒绝当前操作并清理本地租约，之后同一 writer 可以重新接管；其他 owner 持有租约时仍拒绝接管。未知提交的探测读取失败，以及探测为空后重试续租或提交失败，均转为 `COMMIT_OUTCOME_UNKNOWN` 停写并保留原始 cause；探测为空不表示原请求已经结束，不得在未收敛时继续接收新批次。
- 封口以 `SealingMachine.routeOutcome` 区分已知未登记、已登记与结果不明；仅已知未登记且未出现过不确定提交的租约过期允许同 writer 重新接管。路由提交后（含目录交接失败）保持停写，不以同一错误码推测没有副作用；不确定结果不能因后续空读降级为未登记。
- 一次恢复失败后，下次重建使用新的封口协议机，仍读取已登记的 successor ID、base 和截止序号。封口大块快照只由单次调用的有界重试持有，跨调用幂等由已提交路由与 Store 校验，不保留历史 attempt 字节。
- 账本追加只估算新增记录并更新同一 accounting entry 的累计额度；准备阶段不发布 totals，失败保持旧值和 reservations。没有预算时不执行元数据估算；固定基数只计费一次。
- 同一计费 Map 的同一 key 同时只允许一份待提交写入，必须在估算与预留前取得准备权；提交、撤销和准备失败均释放。重复 refs 或重复 retired generation 导致整批拒绝，所有已准备项自动回滚，不得覆盖同一 key 的计费归属或遗失 reservations。
