import { buildDocId, parseDocId } from "../protocol/identity";

/** 导入闭包后的首个 live 块身份固定，恢复与旧文本判重必须沿同一条入口谱系。 */
export function liveContentTailDocId(closureTailDocId: string): string {
  const tail = parseDocId(closureTailDocId);
  return buildDocId({
    kind: "content",
    generation: tail.generation,
    blockIndex: tail.blockIndex + 1,
    nonce: "live-tail",
  });
}
