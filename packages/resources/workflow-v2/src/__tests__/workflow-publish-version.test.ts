// 发布版本号自增（`services/workflow-publish-version.ts`）的行为契约。
//
// 为什么钉在纯函数层：版本号形状与步长不是本平台的自由选择，而是上游协议要求（见模块文件头）——算错一个
// 号段会被上游以「未自增」或「版本名非法」拒绝，而错误信息指向版本号、掩盖真因。控制台发布入口已于
// 2026-10-10 撤除，消费方只剩对外触发链路的运行前自愈（`api-channel-release.ts`）。

import { describe, expect, test } from "bun:test";
import {
  INITIAL_PUBLISH_VERSION,
  nextPublishVersion,
  parsePublishVersion,
} from "../server/services/workflow-publish-version";

describe("发布版本自增（纯函数）", () => {
  // 首发布的版本必须与上游控制台一致（`v0.0.1`）：用户在两处看到的版本序列相同，才不会在渠道自愈时
  // 与画布内发布过的版本冲突。
  test("首次发布取 v0.0.1", () => {
    expect(INITIAL_PUBLISH_VERSION).toBe("v0.0.1");
    expect(nextPublishVersion(null)).toBe("v0.0.1");
  });

  // 已发布过就在同 major.minor 上 patch+1（上游前端 `semver.inc(version, 'patch')` 的同义实现），
  // 且必须**严格大于**上游记录的版本，否则上游会以「未自增」拒绝。
  test("已发布版本按 patch 自增", () => {
    expect(nextPublishVersion("v0.0.1")).toBe("v0.0.2");
    expect(nextPublishVersion("v1.2.9")).toBe("v1.2.10");
    expect(parsePublishVersion("v1.2.10")).toEqual({ major: 1, minor: 2, patch: 10 });
  });

  // 上游返回的版本号形状不合法时返回 null（调用方据此拒绝自增）：拿一个伪造版本去撞上游只会得到「未自增」，
  // 错误信息指向版本号而掩盖真因（上游读到的不是版本号）。
  test("不可解析的版本号返回 null", () => {
    for (const invalid of ["1.0.0", "v1.0", "v1.0.0-beta", "v1.0.x", ""]) {
      expect(parsePublishVersion(invalid)).toBeNull();
    }
    expect(nextPublishVersion("1.0.0")).toBeNull();
  });
});
