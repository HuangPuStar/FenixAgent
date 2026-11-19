import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { MAX_IDENTIFIER_BYTES } from "../protocol/identity";

/** 同一原子批的中间状态可比最终快照大；只允许两份传输上限，不能无界重放。 */
export const TEXT_CLAIM_REPLAY_MAX_BYTES = MAX_DOC_SNAPSHOT_BYTES * 2;
/** 正常状态与一条尚未校准输入的基础解码/工作副本额度。 */
export const TEXT_CLAIM_READ_BASE_BYTES = MAX_DOC_SNAPSHOT_BYTES * 2 * 64 + 8192;
/** 原子批中间态超过正常快照上限后，下次读取前额外资助一份状态。 */
export const TEXT_CLAIM_READ_GROWTH_BYTES = MAX_DOC_SNAPSHOT_BYTES * 64;
/** 启动必须资助完整重放峰值；正常小 Doc 无需常驻占满这份最坏额度。 */
export const TEXT_CLAIM_READ_BODY_BYTES = TEXT_CLAIM_READ_BASE_BYTES + TEXT_CLAIM_READ_GROWTH_BYTES;
/** 单次正文读取的固定元数据，不随原始正文大小借用其他池。 */
export const TEXT_CLAIM_READ_METADATA_BYTES = 8192;
/** 合法最长 docId 下，临时读取器必须能独立取得的控制索引额度。 */
export const TEXT_CLAIM_READ_MIN_CONTROL_BYTES = TEXT_CLAIM_READ_METADATA_BYTES + MAX_IDENTIFIER_BYTES * 4;
