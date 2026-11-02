import { AppError } from "@fenix/platform-sdk";
import { SUBJECT_REJECTION_MESSAGES, type SubjectRejectionReason } from "../ports/subject-verification";

/**
 * 主体复验失败 → 对外应用错误。
 *
 * 这是一条权限结论而不是基础设施故障：裸 `Error` 会被入口兜底成 500，用户看到的是"配置写入失败"，
 * 无法区分"共享被收回"与"服务故障"。Agent 行已不存在按 404（资源消失），其余原因按 403（无权使用）。
 */
export function toSubjectRejectionError(reason: SubjectRejectionReason): AppError {
  if (reason === "AGENT_NOT_FOUND") {
    return new AppError(SUBJECT_REJECTION_MESSAGES[reason], "AGENT_NOT_FOUND", 404);
  }
  return new AppError(SUBJECT_REJECTION_MESSAGES[reason], "AGENT_ACCESS_DENIED", 403);
}
