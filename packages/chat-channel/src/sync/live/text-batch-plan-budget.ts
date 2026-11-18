import { AdmissionController, type Reservation, type ServerPoolName } from "../capacity/admission";
import { DIRECTORY_PAGE_SIZE } from "../protocol/directory";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { MAX_IDENTIFIER_BYTES } from "../protocol/identity";
import type { TextBatchPlanOptions } from "./text-batch-plan-types";

/** Y.Doc、游标、路由/初态记录及额度对象的固定元数据，不以正文大小替代对象数量。 */
const DOCUMENT_METADATA_BYTES = 8192;
/** 字符串切片及其数组槽位；正文UTF-16存储由输入预算单独覆盖。 */
const CHUNK_METADATA_BYTES = 64;

/** 分阶段取得额度，所有构造失败均由同一生命周期归还已取得的部分。 */
export interface TextBatchBudget {
  reserveRecords(count: number): void;
  reserveContentDoc(docId: string): void;
  reserveDirectory(contentDocCount: number): void;
  release(): void;
}

/** 先覆盖源文本、切片与编码副本；记录头和Doc数量再按真实构造量计提。 */
export function reserveTextBatchBudget(options: TextBatchPlanOptions): TextBatchBudget {
  const { capacity, request } = options;
  const admission = options.admission ?? new AdmissionController(capacity);
  const reservations: Reservation[] = [];
  const reserve = (pool: ServerPoolName, size: number) => {
    if (size > 0) reservations.push(admission.reserve(pool, size));
  };
  const release = () => {
    for (const reservation of reservations.splice(0)) reservation.release();
  };
  const chunkBytes = Math.max(
    1,
    Math.min(capacity.inputs.payloadChunkMaxBytes, Math.floor(capacity.inputs.activeHardEncodedBytes / 2)),
  );
  // 非末片至多因下一个四字节码点浪费3B；先界定切片数组，再取得实际片数的记录头额度。
  const chunkCountBound = Math.ceil(request.bytes / Math.max(1, chunkBytes - 3));
  // 旧current可能来自更宽的写入配置；克隆/封口额度按传输硬限保留，不随新active阈值缩小。
  try {
    // live池承担UTF-16源/切片、记录payload和解码Y.Doc；不包含下方独立编码buffer。
    reserve(
      "hotDocLive",
      Math.max(
        1,
        request.text.length * 4 +
          request.bytes * 6 +
          chunkCountBound * CHUNK_METADATA_BYTES +
          DOCUMENT_METADATA_BYTES * 2 +
          MAX_DOC_SNAPSHOT_BYTES * 4 +
          capacity.inputs.directoryHardBytes * 2,
      ),
    );
    // 四类不同编码：待提交update、final snapshot、试写checkpoint和候选编码临时输出。
    reserve(
      "persistSeal",
      Math.max(1, request.bytes * 4 + MAX_DOC_SNAPSHOT_BYTES * 4 + capacity.inputs.directoryHardBytes * 2),
    );
  } catch (error) {
    release();
    throw error;
  }
  const identityUnits = request.key.entryId.length + request.key.contentSlot.length + request.key.contentType.length;
  // 固定七字段记录头≤512B+字符串UTF-8；编码副本与解码对象分别归属，不能只按payload估算。
  const encodedRecordHeaderBytes = 6 * (512 + identityUnits * 3);
  const decodedRecordHeaderBytes = identityUnits * 2 + 1024;
  return {
    reserveRecords(count) {
      reserve("hotDocLive", count * decodedRecordHeaderBytes);
      reserve("persistSeal", count * encodedRecordHeaderBytes);
    },
    reserveContentDoc(docId) {
      reserve("hotDocLive", DOCUMENT_METADATA_BYTES + docId.length * 12);
      reserve("persistSeal", 512 + docId.length * 12);
    },
    reserveDirectory(contentDocCount) {
      if (contentDocCount === 0) return;
      const newPageBound = Math.ceil(contentDocCount / DIRECTORY_PAGE_SIZE) + 1;
      // 当前根/页和本批新页的解码结构与编码引用分开计提，不从其他池借额度。
      reserve("hotDocLive", (contentDocCount + newPageBound + 2) * DOCUMENT_METADATA_BYTES);
      reserve("persistSeal", contentDocCount * (MAX_IDENTIFIER_BYTES + 64) * 4 + newPageBound * 2048);
    },
    release,
  };
}
