import Elysia from "elysia";
import { AppError } from "../errors";

export const errorPlugin = new Elysia({ name: "error-handler" }).onError(({ error, set, code }) => {
  // 自定义错误类优先 — Service 层抛出的 AppError 子类
  if (error instanceof AppError) {
    set.status = error.statusCode;
    return { error: { type: error.code, message: error.message } };
  }

  const status = code === "NOT_FOUND" ? 404 : code === "VALIDATION" ? 400 : 500;
  const type = code === "NOT_FOUND" ? "NOT_FOUND" : code === "VALIDATION" ? "VALIDATION_ERROR" : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);

  set.status = status;
  return { error: { type, message } };
});
