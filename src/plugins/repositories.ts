import { Elysia } from "elysia";
import { environmentRepo, sessionRepo, sessionWorkerRepo, shareLinkRepo, tokenRepo, workItemRepo } from "../repositories";

/** 通过 .decorate() 将仓储单例注入到 Elysia 路由上下文 */
export const repoPlugin = new Elysia({ name: "repositories" }).decorate({
  environmentRepo,
  sessionRepo,
  sessionWorkerRepo,
  shareLinkRepo,
  tokenRepo,
  workItemRepo,
});
