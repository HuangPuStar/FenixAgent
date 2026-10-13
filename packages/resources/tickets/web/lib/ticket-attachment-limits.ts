/**
 * 附件的前端组合规则（计划 §200：每个最多 10 MiB、每次最多 5 个、并发上传最多 2 个；§144：附件流超时 60 秒）。
 *
 * **为什么前端也有一份数值**：浏览器面不得 import `src/server/**`（包内前后端值导入图守卫），而选文件那一刻
 * 就要给出结论——超限文件不该进队列，更不该占一次远端写入与一个幂等键。服务端仍会独立判定一次，这里的数值
 * 与 `src/server/services/ticket-limits.ts` 同源：改一处必须同时改另一处，由
 * `web/__tests__/ticket-attachments.test.tsx` 的常量对齐断言钉住。
 *
 * 「一次最多 5 个」是**每次选择**的组合规则（不是队列总长），「并发 2」才是队列的调度参数——两者混为一谈会
 * 让「传完 3 个再选 3 个」这种正常用法被拒。
 */

/** 单个附件上限（字节）。 */
export const TICKET_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** 一次选入的附件个数上限。 */
export const TICKET_ATTACHMENT_MAX_COUNT = 5;

/** 同时在传的附件数上限，其余排队。 */
export const TICKET_ATTACHMENT_CONCURRENCY = 2;

/** 附件流超时（ms）：普通 API 15 秒，附件流 60 秒（计划 §144）。 */
export const TICKET_ATTACHMENT_TIMEOUT_MS = 60_000;

/** 预检被拒的原因；文案由调用方按原因取字典键，本模块不持有任何文案。 */
export type TicketAttachmentRejectionReason = "tooLarge" | "tooMany" | "empty";

/**
 * 字节数的人类可读形式（`10 MB`、`1.5 MB`）。
 *
 * 与上限常量同处一处：拒绝提示里的 `{{size}}` 与队列里的文件大小都要用它，而两者都必须与
 * {@link TICKET_ATTACHMENT_MAX_BYTES} 同源——在组件里各写一份单位换算，改了上限就会出现「上限 10 MB、
 * 提示 5 MB」这种自相矛盾。小数位按界面语言取分隔符（`Intl.NumberFormat`），单位符号全语言通用。
 */
export function formatAttachmentSize(value: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"] as const;
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const fractionDigits = size >= 100 || Number.isInteger(size) ? 0 : 1;
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: fractionDigits }).format(size);
  return `${formatted} ${units[unit]}`;
}

/** 一个被拒文件及其原因（按文件而非按批次给原因，用户要知道是哪一个不合法）。 */
export interface TicketAttachmentRejection {
  readonly file: File;
  readonly reason: TicketAttachmentRejectionReason;
}

/** 一次文件选择的预检结果。 */
export interface TicketAttachmentSelection {
  readonly accepted: File[];
  readonly rejected: TicketAttachmentRejection[];
}

/**
 * 把一次文件选择拆成「可入队」与「被拒」两半。
 *
 * 拒绝逐文件给出而不是整批否决：用户一次选了 6 个、其中一个是 30 MB 时，把其余可用文件一并退回去只会让他
 * 重新选一遍。判定顺序是先看大小与空文件、再看名额——反过来的话，被名额挤掉的文件会连「它其实不超标」这一
 * 事实都显示不出来。
 */
export function planTicketAttachmentSelection(files: readonly File[]): TicketAttachmentSelection {
  const accepted: File[] = [];
  const rejected: TicketAttachmentRejection[] = [];
  for (const file of files) {
    if (file.size === 0) {
      rejected.push({ file, reason: "empty" });
      continue;
    }
    if (file.size > TICKET_ATTACHMENT_MAX_BYTES) {
      rejected.push({ file, reason: "tooLarge" });
      continue;
    }
    if (accepted.length >= TICKET_ATTACHMENT_MAX_COUNT) {
      rejected.push({ file, reason: "tooMany" });
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejected };
}
