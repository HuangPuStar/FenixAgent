import type { AdmissionController, Reservation } from "../capacity/admission";

/** 只缓存身份并计提共享控制索引额度；删除与生命周期清理均同步归还。 */
export class TextClaimCache {
  private readonly entries = new Map<string, Reservation>();

  constructor(private readonly admission: AdmissionController) {}

  /** 重复身份不重复计费；先取得额度再发布缓存。 */
  add(key: string): void {
    if (this.entries.has(key)) return;
    const reservation = this.admission.reserve("controlIndex", 192 + key.length * 2);
    this.entries.set(key, reservation);
  }

  /** 已完成的身份判定只在当前投影生命周期内有效。 */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 确定未接纳时只释放该身份，不影响其他并发声明。 */
  delete(key: string): void {
    this.entries.get(key)?.release();
    this.entries.delete(key);
  }

  /** 重建或关闭时归还全部身份元数据额度。 */
  clear(): void {
    for (const reservation of this.entries.values()) reservation.release();
    this.entries.clear();
  }
}
