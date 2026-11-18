import type { AdmissionController, Reservation } from "../capacity/admission";
import type { SyncCapacityProfile } from "../capacity/profile";
import { SyncProtocolError } from "../protocol/errors";
import { fidelitySerialize, scanJsonText } from "./fidelity-json";

/** 已完成输入校验的私有 canonical 字节；复用时仍核对接收器的限制。 */
export class AdmittedHistoryPayload {
  readonly #bytes: Uint8Array;
  readonly #limits: { maxBytes: number; maxDepth: number; maxNodes: number };

  constructor(value: unknown, capacity: SyncCapacityProfile) {
    this.#bytes = fidelitySerialize(value);
    this.#limits = {
      maxBytes: capacity.inputs.maxRawAcpFrameBytes,
      maxDepth: capacity.inputs.jsonMaxDepth,
      maxNodes: capacity.inputs.jsonMaxNodes,
    };
    scanJsonText(new TextDecoder("utf-8", { fatal: true }).decode(this.#bytes), this.#limits);
  }

  /** 返回独立字节，避免调用方修改暂存输入或借旧校验绕过新限制。 */
  bytesFor(capacity: SyncCapacityProfile): Uint8Array {
    if (
      this.#limits.maxBytes !== capacity.inputs.maxRawAcpFrameBytes ||
      this.#limits.maxDepth !== capacity.inputs.jsonMaxDepth ||
      this.#limits.maxNodes !== capacity.inputs.jsonMaxNodes
    )
      throw new SyncProtocolError("ADMISSION_REJECTED", { message: "history payload validation limits changed" });
    return this.#bytes.slice();
  }

  /** 批次计费在复制前读取长度，防止先分配大缓冲再申请额度。 */
  get byteLength(): number {
    return this.#bytes.byteLength;
  }
}

/** 原始对象在分片前完成保真、复杂度及大帧接纳；分片不允许绕过原始上限。 */
export function admitHistoryObject(
  value: unknown,
  capacity: SyncCapacityProfile,
  admission?: AdmissionController,
): {
  readonly bytes: Uint8Array;
  readonly payload: AdmittedHistoryPayload;
  readonly reservation: Reservation | null;
} {
  const payload = new AdmittedHistoryPayload(value, capacity);
  const bytes = payload.bytesFor(capacity);
  if (bytes.byteLength <= capacity.inputs.largeFrameThresholdBytes) return { bytes, payload, reservation: null };
  if (!admission)
    throw new SyncProtocolError("ADMISSION_REJECTED", {
      message: "large history objects require frameParse admission",
    });
  return { bytes, payload, reservation: admission.reserve("frameParse", bytes.byteLength) };
}
