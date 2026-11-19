import { AdmissionController, type Reservation, type ServerPoolName } from "../capacity/admission";
import { TEXT_DOCUMENT_METADATA_BYTES, textPlanBaseReservations } from "../capacity/text-plan-reservations";
import { DIRECTORY_PAGE_SIZE } from "../protocol/directory";
import { MAX_IDENTIFIER_BYTES } from "../protocol/identity";
import type { TextBatchPlanOptions } from "./text-batch-plan-types";

/** Y.Doc、游标、路由/初态记录及额度对象的固定元数据，不以正文大小替代对象数量。 */
const DOCUMENT_METADATA_BYTES = TEXT_DOCUMENT_METADATA_BYTES;

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
  const base = textPlanBaseReservations(capacity.inputs, request.text.length, request.bytes);
  // 旧current可能来自更宽的写入配置；克隆/封口额度按传输硬限保留，不随新active阈值缩小。
  try {
    // live池承担UTF-16源/切片、记录payload和解码Y.Doc；不包含下方独立编码buffer。
    reserve("hotDocLive", base.hotDocLive);
    // 四类不同编码：待提交update、final snapshot、试写checkpoint和候选编码临时输出。
    reserve("persistSeal", base.persistSeal);
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
