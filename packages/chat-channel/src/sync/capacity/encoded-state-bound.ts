import * as Y from "yjs";

const SPLIT_BYTES = 64;
const PARENT_SUB_FLAG = 32;

/** 仅可信内存元数据可恢复此缓存；协议输入和可移植快照不得携带它。 */
export interface EncodedStateBoundState {
  readonly bytes: number;
  readonly splitBytes: number;
  readonly uncertain: boolean;
  readonly composite: boolean;
  readonly wrapper?: readonly [number, number];
}

/** 官方解码结果及 Item 原始 map 标志；Yjs 解码 Item 会省略继承的 parentSub。 */
export interface DecodedStateUpdate {
  readonly decoded: ReturnType<typeof Y.decodeUpdate>;
  readonly mapWrites: boolean;
}

/** 不确定时不证明大小；精确编码且确认无 pending 后才释放延迟激活的拆分余量。 */
export interface EncodedStateBound {
  readonly upperBytes: number;
  add(update: Uint8Array, decoded?: DecodedStateUpdate): void;
  calibrate(actualBytes: number, doc: Y.Doc): void;
  snapshot(): EncodedStateBoundState;
}

/** 继承公开的官方 v1 解码器，仅旁观 info 标志，不重新实现二进制解析。 */
export function decodeStateUpdate(update: Uint8Array): DecodedStateUpdate {
  let mapWrites = false;
  class InspectingDecoder extends Y.UpdateDecoderV1 {
    override readInfo(): number {
      const info = super.readInfo();
      if ((info & PARENT_SUB_FLAG) !== 0) mapWrites = true;
      return info;
    }
  }
  return { decoded: Y.decodeUpdateV2(update, InspectingDecoder), mapWrites };
}

function cost(update: DecodedStateUpdate) {
  let items = 0;
  let composite = false,
    uncertain = false,
    intervals = 0;
  for (const ranges of update.decoded.ds.clients.values()) intervals += ranges.length;
  for (const struct of update.decoded.structs) {
    if (!(struct instanceof Y.Item)) {
      if (!(struct instanceof Y.GC)) uncertain = true;
      continue;
    }
    items++;
    const content = struct.content;
    if (
      !(
        content instanceof Y.ContentAny ||
        content instanceof Y.ContentJSON ||
        content instanceof Y.ContentString ||
        content instanceof Y.ContentBinary ||
        content instanceof Y.ContentEmbed ||
        content instanceof Y.ContentDeleted
      )
    ) {
      composite = true;
      uncertain = true;
    }
  }
  // origin/rightOrigin 各最多拆一段；第三份余量覆盖重叠输入的 offset 改写。
  // 右段 origin 非空，不重复 parent 字符串；53-bit varuint、两 ID、计数/长度和代理对修复共小于 64B。
  // 无嵌套类型时，删除只缩短内容；每区间首尾最多各拆一段。map 的单值删除也由第三份余量覆盖。
  return {
    splitBytes: (items * 3 + intervals * 2) * SPLIT_BYTES,
    uncertain,
    composite,
    mutates: update.mapWrites || intervals > 0,
  };
}

function add(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

/** 唯一标准 records wrapper 才可复用两数定位；任何其它 map、删除历史或嵌套类型均不证明。 */
function standardWrapper(doc: Y.Doc): readonly [number, number] | undefined {
  const root = doc.share.get("root"),
    wrapper = root?._map.get("records");
  const records = wrapper?.content instanceof Y.ContentType ? wrapper.content.type : undefined;
  if (wrapper?.length !== 1 || wrapper.deleted || !(records instanceof Y.Array)) return;
  let found = false;
  for (const structs of doc.store.clients.values())
    for (const struct of structs) {
      if (!(struct instanceof Y.Item) || struct.deleted || struct.content instanceof Y.ContentDeleted) return;
      if (struct === wrapper) {
        if (struct.parent !== root || struct.parentSub !== "records") return;
        found = true;
        continue;
      }
      if (
        struct.parent !== records ||
        struct.parentSub !== null ||
        !(
          struct.content instanceof Y.ContentAny ||
          struct.content instanceof Y.ContentJSON ||
          struct.content instanceof Y.ContentEmbed ||
          struct.content instanceof Y.ContentBinary ||
          struct.content instanceof Y.ContentString
        )
      )
        return;
    }
  return found ? [wrapper.id.client, wrapper.id.clock] : undefined;
}

/** base 与全部更新都计提拆分余量，pending 稍后激活也不能使用未付费的编码头。 */
export function createEncodedStateBound(base: Uint8Array | EncodedStateBoundState): EncodedStateBound {
  const initial = base instanceof Uint8Array ? cost(decodeStateUpdate(base)) : base;
  let bytes = base instanceof Uint8Array ? add(base.byteLength, initial.splitBytes) : base.bytes;
  let splitBytes = initial.splitBytes;
  let uncertain = initial.uncertain;
  let composite = initial.composite;
  let wrapper = base instanceof Uint8Array ? undefined : base.wrapper;
  if (base instanceof Uint8Array && composite) uncertain = true;
  return {
    get upperBytes() {
      return uncertain ? Number.POSITIVE_INFINITY : bytes;
    },
    add(update, decoded = decodeStateUpdate(update)) {
      const next = cost(decoded);
      const inheritedMap =
        wrapper !== undefined &&
        decoded.decoded.structs.some(
          (struct) =>
            struct instanceof Y.Item &&
            [struct.origin, struct.rightOrigin].some((id) => id?.client === wrapper![0] && id.clock === wrapper![1]),
        );
      bytes = add(bytes, add(update.byteLength, next.splitBytes));
      splitBytes = add(splitBytes, next.splitBytes);
      composite ||= next.composite;
      uncertain ||= next.uncertain || (composite && (!wrapper || next.mutates || inheritedMap));
    },
    calibrate(actualBytes, doc) {
      if (doc.store.pendingStructs === null && doc.store.pendingDs === null) {
        bytes = actualBytes;
        splitBytes = 0;
        uncertain = false;
        wrapper = composite ? standardWrapper(doc) : undefined;
      } else bytes = add(actualBytes, splitBytes);
    },
    snapshot() {
      return { bytes, splitBytes, uncertain, composite, wrapper };
    },
  };
}

/** 已实际编码的 Doc 可形成可信数值检查点，pending 结构仍保留其后续激活余量。 */
export function measuredEncodedStateBound(snapshot: Uint8Array, doc: Y.Doc): EncodedStateBoundState {
  const bound = createEncodedStateBound(snapshot);
  bound.calibrate(snapshot.byteLength, doc);
  return bound.snapshot();
}
