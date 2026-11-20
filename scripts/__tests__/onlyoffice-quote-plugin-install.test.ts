import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 生产组件必须能携带独立资源部署，安装脚本只更新自己的四个插件文件。
test("installs quote assets into the standalone OnlyOffice component", () => {
  const directory = mkdtempSync(join(tmpdir(), "fenix-office-quote-"));
  try {
    const component = join(directory, "component");
    const source = join(directory, "source");
    const target = join(component, "plugins/conversation-quote");
    mkdirSync(target, { recursive: true });
    mkdirSync(source);
    writeFileSync(join(target, "keep.txt"), "unrelated");
    const assets = ["config.json", "index.html", "selection.js", "main.js"];
    for (const asset of assets) writeFileSync(join(source, asset), `content of ${asset}\n`);
    const installer = join(component, "install-quote-plugin.sh");
    copyFileSync(resolve(import.meta.dir, "../../docker/onlyoffice/install-quote-plugin.sh"), installer);
    const run = () => Bun.spawnSync(["sh", installer, source]);
    expect(run().exitCode).toBe(0);
    for (const asset of assets) expect(readFileSync(join(target, asset))).toEqual(readFileSync(join(source, asset)));
    writeFileSync(join(source, "main.js"), "updated");
    expect(run().exitCode).toBe(0);
    expect(readFileSync(join(target, "main.js"), "utf8")).toBe("updated");
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("unrelated");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 缺少资源时应在更新前失败，不能让一半新一半旧的插件进入部署目录。
test("rejects incomplete plugin assets before updating the installed copy", () => {
  const directory = mkdtempSync(join(tmpdir(), "fenix-office-quote-"));
  try {
    const source = join(directory, "source");
    const target = join(directory, "plugins/conversation-quote");
    mkdirSync(source);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, "config.json"), "new");
    writeFileSync(join(target, "config.json"), "old");
    const installer = join(directory, "install-quote-plugin.sh");
    copyFileSync(resolve(import.meta.dir, "../../docker/onlyoffice/install-quote-plugin.sh"), installer);
    const result = Bun.spawnSync(["sh", installer, source]);
    expect(result.exitCode).toBe(1);
    expect(readFileSync(join(target, "config.json"), "utf8")).toBe("old");
    expect(existsSync(join(target, "main.js"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
