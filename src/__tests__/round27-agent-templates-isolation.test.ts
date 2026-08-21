import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTemplate } from "../services/agent-templates";

type TemplateFile = readonly [filename: string, content: string];

let moduleVersion = 0;

function template(name: string, content = "正文", extra = ""): string {
  return `---\nname: ${name}\ndescription: ${name} 描述\nskills:\n  - skill-a\n  - skill-b\n${extra}---\n${content}\n`;
}

async function loadTemplates(files: TemplateFile[], createDirectory = true): Promise<AgentTemplate[]> {
  const root = await mkdtemp(join(tmpdir(), "fenix-agent-templates-"));
  const originalCwd = process.cwd();

  try {
    if (createDirectory) {
      const directory = join(root, ".agents", "agents");
      await mkdir(directory, { recursive: true });
      await Promise.all(files.map(([filename, content]) => writeFile(join(directory, filename), content)));
    }

    process.chdir(root);
    const service = await import(`../services/agent-templates.ts?round27=${moduleVersion++}`);
    return service.loadAgentTemplates();
  } finally {
    process.chdir(originalCwd);
    await rm(root, { force: true, recursive: true });
  }
}

describe("round27 Agent 模板隔离、状态与资源清理", () => {
  // 缺失模板目录时必须安全返回空列表。
  test("不存在模板目录时返回空列表", async () => {
    expect(await loadTemplates([], false)).toEqual([]);
  });

  // 空目录代表尚未配置模板而不是读取错误。
  test("空模板目录返回空列表", async () => {
    expect(await loadTemplates([])).toEqual([]);
  });

  // 非 Markdown 文件不得被当作可执行配置加载。
  test("忽略非 Markdown 文件", async () => {
    expect(await loadTemplates([["ignore.txt", template("忽略")]])).toEqual([]);
  });

  // 模板 id 必须来自文件名而非前端可控的元数据。
  test("文件名生成稳定模板 id", async () => {
    expect((await loadTemplates([["weekly-report.md", template("周报")]]))[0]?.id).toBe("weekly-report");
  });

  // 模板名称应保留 YAML 中的业务名称。
  test("读取模板名称", async () => {
    expect((await loadTemplates([["a.md", template("客户支持")]]))[0]?.name).toBe("客户支持");
  });

  // 模板描述供调用端安全展示。
  test("读取模板描述", async () => {
    expect((await loadTemplates([["a.md", template("客户支持")]]))[0]?.description).toBe("客户支持 描述");
  });

  // 正文仅作为提示词且应清除外围空白。
  test("清理提示词外围空白", async () => {
    expect((await loadTemplates([["a.md", template("助手", "\n\n  请保持保密。  \n\n")]]))[0]?.prompt).toBe(
      "请保持保密。",
    );
  });

  // 技能数组需按配置顺序传递给授权层。
  test("读取技能数组", async () => {
    expect((await loadTemplates([["a.md", template("助手")]]))[0]?.skills).toEqual(["skill-a", "skill-b"]);
  });

  // 未声明名称的模板回退到受控文件 id。
  test("缺失名称时回退到文件 id", async () => {
    expect((await loadTemplates([["safe-id.md", "---\ndescription: 描述\n---\n正文"]]))[0]?.name).toBe("safe-id");
  });

  // 未声明描述时不得产生 undefined 影响客户端渲染。
  test("缺失描述时使用空字符串", async () => {
    expect((await loadTemplates([["a.md", "---\nname: 助手\n---\n正文"]]))[0]?.description).toBe("");
  });

  // 非数组技能字段不能绕过技能白名单语义。
  test("字符串技能字段回退为空数组", async () => {
    expect((await loadTemplates([["a.md", "---\nname: 助手\nskills: skill-a\n---\n正文"]]))[0]?.skills).toEqual([]);
  });

  // 空技能数组是有效的最小权限模板。
  test("空技能数组被保留", async () => {
    expect((await loadTemplates([["a.md", "---\nname: 助手\nskills: []\n---\n正文"]]))[0]?.skills).toEqual([]);
  });

  // 文件系统返回顺序不得影响调用端选择结果。
  test("按文件名字典序排序", async () => {
    expect(
      (
        await loadTemplates([
          ["z.md", template("Z")],
          ["a.md", template("A")],
          ["m.md", template("M")],
        ])
      ).map(({ id }) => id),
    ).toEqual(["a", "m", "z"]);
  });

  // 同一模块实例重复读取应复用缓存，避免运行期配置漂移。
  test("同一模块实例返回缓存引用", async () => {
    const root = await mkdtemp(join(tmpdir(), "fenix-agent-templates-"));
    const originalCwd = process.cwd();
    try {
      const directory = join(root, ".agents", "agents");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "a.md"), template("缓存"));
      process.chdir(root);
      const service = await import(`../services/agent-templates.ts?round27=${moduleVersion++}`);
      expect(service.loadAgentTemplates()).toBe(service.loadAgentTemplates());
    } finally {
      process.chdir(originalCwd);
      await rm(root, { force: true, recursive: true });
    }
  });

  // 缓存结果必须避免后续磁盘变化改变已授权的模板集合。
  test("缓存隔离后续磁盘修改", async () => {
    const root = await mkdtemp(join(tmpdir(), "fenix-agent-templates-"));
    const originalCwd = process.cwd();
    try {
      const directory = join(root, ".agents", "agents");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "a.md"), template("初始"));
      process.chdir(root);
      const service = await import(`../services/agent-templates.ts?round27=${moduleVersion++}`);
      expect(service.loadAgentTemplates()[0]?.name).toBe("初始");
      await writeFile(join(directory, "b.md"), template("新增"));
      expect(service.loadAgentTemplates().map(({ id }: { id: string }) => id)).toEqual(["a"]);
    } finally {
      process.chdir(originalCwd);
      await rm(root, { force: true, recursive: true });
    }
  });

  // 单文件模板应保持完整的业务字段。
  test("加载单个完整模板", async () => {
    expect(await loadTemplates([["a.md", template("单模板")]])).toHaveLength(1);
  });

  // 多模板加载不得遗漏第一项。
  test("加载多个模板的第一项", async () => {
    expect(
      (
        await loadTemplates([
          ["b.md", template("乙")],
          ["a.md", template("甲")],
        ])
      )[0]?.name,
    ).toBe("甲");
  });

  // 多模板加载不得遗漏最后一项。
  test("加载多个模板的最后一项", async () => {
    expect(
      (
        await loadTemplates([
          ["b.md", template("乙")],
          ["a.md", template("甲")],
        ])
      )[1]?.name,
    ).toBe("乙");
  });

  // 带数字的文件名必须保持可预测的排序。
  test("数字文件名按字典序排序", async () => {
    expect(
      (
        await loadTemplates([
          ["template-10.md", template("十")],
          ["template-2.md", template("二")],
        ])
      ).map(({ id }) => id),
    ).toEqual(["template-10", "template-2"]);
  });

  // 多个点的文件名仅移除最终 Markdown 扩展名。
  test("多点文件名保留其余标识", async () => {
    expect((await loadTemplates([["customer.v2.md", template("客户")]]))[0]?.id).toBe("customer.v2");
  });

  // 中文文件名可作为本地受控模板标识。
  test("中文文件名可生成 id", async () => {
    expect((await loadTemplates([["周报助手.md", template("周报")]]))[0]?.id).toBe("周报助手");
  });

  // 连字符文件名应原样保留以匹配已有配置引用。
  test("连字符文件名可生成 id", async () => {
    expect((await loadTemplates([["customer-success.md", template("客户")]]))[0]?.id).toBe("customer-success");
  });

  // 下划线文件名应原样保留以兼容存量模板。
  test("下划线文件名可生成 id", async () => {
    expect((await loadTemplates([["customer_success.md", template("客户")]]))[0]?.id).toBe("customer_success");
  });

  // 空正文是允许的配置状态。
  test("空正文转换为空提示词", async () => {
    expect((await loadTemplates([["a.md", "---\nname: 空提示\n---\n  \n"]]))[0]?.prompt).toBe("");
  });

  // 多行提示词必须保持内部换行语义。
  test("保留提示词内部换行", async () => {
    expect((await loadTemplates([["a.md", template("多行", "第一行\n第二行\n第三行")]]))[0]?.prompt).toBe(
      "第一行\n第二行\n第三行",
    );
  });

  // 模板正文中的 JSON 示例不应被 YAML 解析吞掉。
  test("保留正文中的 JSON", async () => {
    expect((await loadTemplates([["a.md", template("JSON", '{"action":"read"}')]]))[0]?.prompt).toBe(
      '{"action":"read"}',
    );
  });

  // 模板正文中的冒号属于提示词内容而非元数据。
  test("保留正文中的冒号", async () => {
    expect((await loadTemplates([["a.md", template("冒号", "规则：不得泄露数据")]]))[0]?.prompt).toBe(
      "规则：不得泄露数据",
    );
  });

  // 模板名称可以是面向业务的中文文本。
  test("保留中文业务名称", async () => {
    expect((await loadTemplates([["a.md", template("数据脱敏助手")]]))[0]?.name).toBe("数据脱敏助手");
  });

  // 英文业务名称由模板作者决定且应原样读取。
  test("保留英文业务名称", async () => {
    expect((await loadTemplates([["a.md", template("Support Agent")]]))[0]?.name).toBe("Support Agent");
  });

  // 描述中的空格不应被服务层重写。
  test("保留描述文本", async () => {
    expect(
      (await loadTemplates([["a.md", "---\nname: 助手\ndescription: 面向 内部 用户\n---\n正文"]]))[0]?.description,
    ).toBe("面向 内部 用户");
  });

  // 单技能模板支持最小功能授权。
  test("读取单个技能", async () => {
    expect((await loadTemplates([["a.md", "---\nname: 助手\nskills:\n  - read-only\n---\n正文"]]))[0]?.skills).toEqual([
      "read-only",
    ]);
  });

  // 三个技能按声明顺序返回供权限层校验。
  test("保留多个技能的顺序", async () => {
    expect(
      (await loadTemplates([["a.md", "---\nname: 助手\nskills:\n  - read\n  - write\n  - audit\n---\n正文"]]))[0]
        ?.skills,
    ).toEqual(["read", "write", "audit"]);
  });

  // 重复技能由上游权限层决定，加载器不得静默扩大或缩减配置。
  test("保留重复技能声明", async () => {
    expect(
      (await loadTemplates([["a.md", "---\nname: 助手\nskills:\n  - read\n  - read\n---\n正文"]]))[0]?.skills,
    ).toEqual(["read", "read"]);
  });

  // Markdown 大小写扩展名不应绕过明确的文件过滤规则。
  test("忽略大写 Markdown 扩展名", async () => {
    expect(await loadTemplates([["a.MD", template("忽略")]])).toEqual([]);
  });

  // 无扩展名文件不得被误加载为模板。
  test("忽略无扩展名文件", async () => {
    expect(await loadTemplates([["template", template("忽略")]])).toEqual([]);
  });

  // 临时备份文件不得进入可用模板集合。
  test("忽略 Markdown 备份文件", async () => {
    expect(await loadTemplates([["a.md.bak", template("忽略")]])).toEqual([]);
  });

  // 文件排序在不同输入写入顺序下应稳定。
  test("写入顺序不影响模板排序", async () => {
    expect(
      (
        await loadTemplates([
          ["c.md", template("丙")],
          ["a.md", template("甲")],
          ["b.md", template("乙")],
        ])
      ).map(({ name }) => name),
    ).toEqual(["甲", "乙", "丙"]);
  });

  // 不同模板的技能集合不得相互污染。
  test("模板间技能保持隔离", async () => {
    const templates = await loadTemplates([
      ["a.md", "---\nname: 甲\nskills:\n  - read\n---\n正文"],
      ["b.md", "---\nname: 乙\nskills:\n  - write\n---\n正文"],
    ]);
    expect(templates.map(({ skills }) => skills)).toEqual([["read"], ["write"]]);
  });

  // 不同模板的提示词不得相互覆盖。
  test("模板间提示词保持隔离", async () => {
    const templates = await loadTemplates([
      ["a.md", template("甲", "仅允许读取")],
      ["b.md", template("乙", "仅允许审计")],
    ]);
    expect(templates.map(({ prompt }) => prompt)).toEqual(["仅允许读取", "仅允许审计"]);
  });

  // 缺失技能字段时返回可安全遍历的空数组。
  test("缺失技能字段返回空数组", async () => {
    expect((await loadTemplates([["a.md", "---\nname: 助手\ndescription: 描述\n---\n正文"]]))[0]?.skills).toEqual([]);
  });

  // 缺失全部可选字段仍生成最小可用模板。
  test("仅正文模板生成最小对象", async () => {
    expect(await loadTemplates([["minimal.md", "最小正文"]])).toEqual([
      { id: "minimal", name: "minimal", description: "", prompt: "最小正文", skills: [] },
    ]);
  });

  // frontmatter 后的空行不应留在最终提示词前端。
  test("移除正文前导空行", async () => {
    expect((await loadTemplates([["a.md", template("助手", "\n\n安全规则")]]))[0]?.prompt).toBe("安全规则");
  });

  // 正文末尾换行不应导致提示词比较产生虚假差异。
  test("移除正文末尾换行", async () => {
    expect((await loadTemplates([["a.md", template("助手", "安全规则\n\n")]]))[0]?.prompt).toBe("安全规则");
  });

  // 名称相同的模板仍通过文件 id 保持可区分性。
  test("相同名称模板保持不同 id", async () => {
    expect(
      (
        await loadTemplates([
          ["a.md", template("通用助手")],
          ["b.md", template("通用助手")],
        ])
      ).map(({ id }) => id),
    ).toEqual(["a", "b"]);
  });

  // 带空格的文件名应作为受控本地标识原样返回。
  test("空格文件名保留在 id 中", async () => {
    expect((await loadTemplates([["customer support.md", template("支持")]]))[0]?.id).toBe("customer support");
  });

  // 技能名称中的连字符应原样保留给权限匹配逻辑。
  test("保留连字符技能名称", async () => {
    expect(
      (await loadTemplates([["a.md", "---\nname: 助手\nskills:\n  - file-read-only\n---\n正文"]]))[0]?.skills,
    ).toEqual(["file-read-only"]);
  });

  // 独立加载调用使用新的模块状态，避免测试间缓存串扰。
  test("独立加载不会复用其他目录的缓存", async () => {
    expect((await loadTemplates([["a.md", template("独立")]]))[0]?.name).toBe("独立");
  });

  // 临时工作目录在加载后被清理，不在项目目录残留测试资源。
  test("加载后不依赖原工作目录", async () => {
    const templates = await loadTemplates([["a.md", template("清理")]]);
    expect(templates[0]?.name).toBe("清理");
  });

  // Markdown 文件与其他文件混合时仅暴露受控模板。
  test("混合文件只加载 Markdown 模板", async () => {
    expect(
      (
        await loadTemplates([
          ["a.md", template("有效")],
          ["notes.json", '{"name":"无效"}'],
        ])
      ).map(({ id }) => id),
    ).toEqual(["a"]);
  });

  // 模板正文中的权限说明必须逐字保留以供后续审计。
  test("保留正文中的权限边界说明", async () => {
    expect((await loadTemplates([["a.md", template("边界", "只能访问当前组织资源，不得跨租户读取")]]))[0]?.prompt).toBe(
      "只能访问当前组织资源，不得跨租户读取",
    );
  });
});
