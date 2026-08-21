import { describe, expect, test } from "bun:test";

import { getFileExtension } from "../components/file-icon-helper";
import {
  getRegisteredAllowedTags,
  getRegisteredComponents,
  getRegisteredTags,
  getTagRenderer,
  registerTagRenderer,
} from "../lib/card-renderer/registry";

const firstRenderer = (_props: Record<string, unknown>) => null;
const secondRenderer = (_props: Record<string, unknown>) => null;
const fallbackRenderer = (_props: Record<string, unknown>) => null;

describe("文件扩展名解析", () => {
  // 常规文件名应提取最后一个点号后的扩展名。
  test("提取普通文件的扩展名", () => {
    expect(getFileExtension("report.pdf")).toBe("pdf");
  });

  // 大写扩展名应归一化为小写，供图标映射稳定匹配。
  test("将大写扩展名归一化为小写", () => {
    expect(getFileExtension("PHOTO.JPEG")).toBe("jpeg");
  });

  // 多个点号时只应使用最后一个片段作为扩展名。
  test("从多点文件名提取最后一个扩展名", () => {
    expect(getFileExtension("archive.backup.tar.gz")).toBe("gz");
  });

  // 无点号的文件名没有可用于匹配图标的扩展名。
  test("无扩展名文件返回空字符串", () => {
    expect(getFileExtension("LICENSE")).toBe("");
  });

  // 末尾点号不构成有效扩展名，避免产生空映射键。
  test("末尾点号返回空字符串", () => {
    expect(getFileExtension("draft.")).toBe("");
  });

  // 隐藏文件的首点后内容仍是可识别的扩展名。
  test("将隐藏文件名首点后的内容视为扩展名", () => {
    expect(getFileExtension(".gitignore")).toBe("gitignore");
  });

  // 仅一个点号的文件名没有扩展名内容。
  test("单独点号返回空字符串", () => {
    expect(getFileExtension(".")).toBe("");
  });

  // 路径中的目录点号不能影响最终文件名的扩展名解析。
  test("保留路径末尾文件名的扩展名", () => {
    expect(getFileExtension("releases/v1.2/readme.MD")).toBe("md");
  });

  // 扩展名中的数字应被原样保留，支持脚本类文件。
  test("保留扩展名中的数字", () => {
    expect(getFileExtension("deploy.PS1")).toBe("ps1");
  });

  // 连续点号后仍应提取最后一个非空片段。
  test("处理连续点号后的扩展名", () => {
    expect(getFileExtension("release..JSON")).toBe("json");
  });
});

describe("卡片渲染器注册表", () => {
  // 未注册标签查询应返回 undefined，而不是构造空配置。
  test("未注册标签返回 undefined", () => {
    expect(getTagRenderer("coverage-registry-missing")).toBeUndefined();
  });

  // 注册后应能按标签名读取同一个配置对象。
  test("注册并读取标签配置", () => {
    const config = { component: firstRenderer };
    registerTagRenderer("coverage-registry-read", config);

    expect(getTagRenderer("coverage-registry-read")).toBe(config);
  });

  // 已注册标签列表应包含新标签，供 streamdown 构造白名单。
  test("注册标签出现在标签列表中", () => {
    registerTagRenderer("coverage-registry-list", { component: firstRenderer });

    expect(getRegisteredTags()).toContain("coverage-registry-list");
  });

  // 组件映射只暴露注册配置中的 component 字段。
  test("组件映射保留标签与组件对应关系", () => {
    registerTagRenderer("coverage-registry-components", { component: secondRenderer, fallback: fallbackRenderer });

    expect(getRegisteredComponents()["coverage-registry-components"]).toBe(secondRenderer);
  });

  // 未声明属性规则时应使用允许所有属性的默认值。
  test("缺省属性规则回退到通配符", () => {
    registerTagRenderer("coverage-registry-default-attrs", { component: firstRenderer });

    expect(getRegisteredAllowedTags()["coverage-registry-default-attrs"]).toEqual(["*"]);
  });

  // 显式属性白名单必须原样传递给 sanitize 配置。
  test("保留显式属性白名单", () => {
    registerTagRenderer("coverage-registry-custom-attrs", {
      component: firstRenderer,
      allowedAttrs: ["data-id", "title"],
    });

    expect(getRegisteredAllowedTags()["coverage-registry-custom-attrs"]).toEqual(["data-id", "title"]);
  });

  // 空属性白名单是有效的严格配置，不得误回退为通配符。
  test("保留空属性白名单", () => {
    registerTagRenderer("coverage-registry-empty-attrs", { component: firstRenderer, allowedAttrs: [] });

    expect(getRegisteredAllowedTags()["coverage-registry-empty-attrs"]).toEqual([]);
  });

  // 覆盖注册应替换已存配置，使最新组件成为实际渲染器。
  test("重复注册使用最新配置", () => {
    registerTagRenderer("coverage-registry-overwrite", { component: firstRenderer });
    registerTagRenderer("coverage-registry-overwrite", { component: secondRenderer });

    expect(getTagRenderer("coverage-registry-overwrite")?.component).toBe(secondRenderer);
  });

  // 覆盖注册不应在标签列表中重复插入相同标签。
  test("重复注册不重复增加标签", () => {
    const tag = "coverage-registry-unique";
    registerTagRenderer(tag, { component: firstRenderer });
    const before = getRegisteredTags().filter((registeredTag) => registeredTag === tag).length;
    registerTagRenderer(tag, { component: secondRenderer });

    expect(getRegisteredTags().filter((registeredTag) => registeredTag === tag)).toHaveLength(before);
  });

  // 组件映射与属性白名单应支持同时包含多个独立标签。
  test("聚合多个标签的组件与属性配置", () => {
    registerTagRenderer("coverage-registry-aggregate-a", { component: firstRenderer, allowedAttrs: ["id"] });
    registerTagRenderer("coverage-registry-aggregate-b", { component: secondRenderer });

    const components = getRegisteredComponents();
    const allowedTags = getRegisteredAllowedTags();
    expect(components["coverage-registry-aggregate-a"]).toBe(firstRenderer);
    expect(components["coverage-registry-aggregate-b"]).toBe(secondRenderer);
    expect(allowedTags["coverage-registry-aggregate-a"]).toEqual(["id"]);
    expect(allowedTags["coverage-registry-aggregate-b"]).toEqual(["*"]);
  });
});
