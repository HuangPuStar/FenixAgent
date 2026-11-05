import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createSkillDownloadRoutes } from "../skill-downloads";

// 下载包可直接解压安装，内容与项目维护的技能及引用文件一致。
test("downloads complete standalone skill archives without credentials", async () => {
  const app = createSkillDownloadRoutes();
  for (const [name, expected] of [
    [
      "deploy-opensandbox-node",
      [
        "SKILL.md",
        "references/deployment.md",
        "assets/compose.yaml",
        "assets/direct.yaml",
        "assets/tunnel.yaml",
        "assets/sandbox.toml.example",
      ],
    ],
    ["use-opensandbox-sandbox", ["SKILL.md", "references/lifecycle.md", "references/access.md"]],
  ] as const) {
    const response = await app.handle(new Request(`http://cluster/skills/${name}/download`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${name}.tar.gz"`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const entries = await new Bun.Archive(await response.arrayBuffer()).files();
    expect([...entries.keys()].sort()).toEqual(expected.map((file) => `${name}/${file}`).sort());
    for (const file of expected) {
      const source = fileURLToPath(new URL(`../../skills/${name}/${file}`, import.meta.url));
      expect(await entries.get(`${name}/${file}`)?.text()).toBe(await Bun.file(source).text());
    }
  }
});

// 名称和文件使用固定白名单，拒绝其他技能、原型属性和路径穿越。
test("rejects unknown skills and traversal requests", async () => {
  const app = createSkillDownloadRoutes();
  for (const name of ["unknown", "skill-creator", "constructor", "__proto__", "%2e%2e%2fskill-creator"]) {
    expect((await app.handle(new Request(`http://cluster/skills/${name}/download`))).status).toBe(404);
  }
});
