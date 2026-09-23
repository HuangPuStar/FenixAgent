// web/__tests__/agent-site-url.test.ts
// 站点地址拼装口径的回归用例。重构前这条规则在包内写了三份（卡片 iframe / 站点外壳 iframe+新窗口+二维码 /
// 目录页 <a href>），其中只有目录页对 appId 做了 encodeURIComponent。用例固定两件事：
//   1. 受控 id（平台生成的 `app-xxxxxxxx`）下，统一实现与重构前的两种写法**逐字一致**——收敛零行为变更；
//   2. 特殊字符 id 下裸拼会被 URL 解析器改写（逃出前缀 / 丢尾斜杠 / 变成 query 或 fragment），编码实现把整段
//      收在一个 path segment 内——口径差异真实存在，但当前输入域不可达（见 lib 的模块注释与提交说明）。
import { describe, expect, test } from "bun:test";
import { buildAgentSiteAbsoluteUrl, buildAgentSiteUrl } from "../lib/agent-site-url";

const ORIGIN = "https://rcs.example.com";
const DEPLOY_PREFIX = "/web/site/deploy/";

/** 重构前 AgentSitesCard / SiteFrame 的裸拼写法，仅作对照，不用于生产代码。 */
const legacyRawUrl = (remoteAppId: string) => `/web/site/deploy/${remoteAppId}/`;
/** 重构前 agent-sites-catalog 的写法（三处中唯一做过编码的一处）。 */
const legacyEncodedUrl = (remoteAppId: string) => `/web/site/deploy/${encodeURIComponent(remoteAppId)}/`;

describe("buildAgentSiteUrl", () => {
  test("平台生成的 app-xxxxxxxx 口径下与重构前两种写法逐字一致", () => {
    // 实测取值来源：apps/web/src/shell/ArtifactsPanel.tsx（`app-91a0621c`）、
    // docs/developer/site-url-migration.md（`app-e1895c18`）、宿主聚合验证记录（`app-verify0`）。
    for (const remoteAppId of ["app-91a0621c", "app-e1895c18", "app-verify0"]) {
      expect(buildAgentSiteUrl(remoteAppId)).toBe(legacyRawUrl(remoteAppId));
      expect(buildAgentSiteUrl(remoteAppId)).toBe(legacyEncodedUrl(remoteAppId));
    }
  });

  test("空格 / 中文在旧裸拼接下本来就等价：URL 解析器会自行 percent-encode", () => {
    // 这条用来钉住「不是所有非 ASCII 都是差异点」：裸拼只在 `#` `?` `%` `/` 上与编码口径分叉。
    for (const remoteAppId of ["app-a b", "站点-1", "app-中文"]) {
      expect(new URL(legacyRawUrl(remoteAppId), ORIGIN).pathname).toBe(
        new URL(buildAgentSiteUrl(remoteAppId), ORIGIN).pathname,
      );
    }
  });

  test("裸拼在 `#` / `?` / `%` / `/` 上被解析器改写，编码实现恒为单个 path segment", () => {
    for (const remoteAppId of ["app-x#frag", "app-x?q=1", "app-x%2f", "app-x/y", "app-x/../../evil"]) {
      const encoded = new URL(buildAgentSiteUrl(remoteAppId), ORIGIN);
      const legacy = new URL(legacyRawUrl(remoteAppId), ORIGIN);

      // 编码侧：整段 id 落在 deploy 前缀下的同一个 path segment 内，且保留尾斜杠、无 query / fragment。
      expect(encoded.pathname.slice(DEPLOY_PREFIX.length)).toBe(`${encodeURIComponent(remoteAppId)}/`);
      expect(encoded.search).toBe("");
      expect(encoded.hash).toBe("");
      // 裸拼侧：`#` / `?` 丢掉尾斜杠与后续路径，`/` 拆段并触发相对路径归一化（`/web/site/evil/`）。
      expect(encoded.pathname).not.toBe(legacy.pathname);
    }
  });

  test("已知边界：纯点段不受 encodeURIComponent 保护（登记而非本模块修复）", () => {
    // `.` 不在 encodeURIComponent 的编码集内，`..` 仍会被解析器按相对路径归一化。拦截只能靠抛错或返回
    // 哨兵值，会给三个调用点引入新的失败分支；remoteAppId 由平台 `POST /api/apps` 生成，点段不可达。
    expect(new URL(buildAgentSiteUrl(".."), ORIGIN).pathname).toBe("/web/site/");
  });
});

describe("buildAgentSiteAbsoluteUrl", () => {
  test("origin + 同源部署路径 = 分享 / 二维码地址", () => {
    expect(buildAgentSiteAbsoluteUrl(buildAgentSiteUrl("app-91a0621c"), ORIGIN)).toBe(
      "https://rcs.example.com/web/site/deploy/app-91a0621c/",
    );
    // 编码口径在绝对地址上同样成立：`#` 已被段内编码，不会再被当成 fragment 起点。
    expect(buildAgentSiteAbsoluteUrl(buildAgentSiteUrl("app-x#frag"), ORIGIN)).toBe(
      "https://rcs.example.com/web/site/deploy/app-x%23frag/",
    );
  });
});
