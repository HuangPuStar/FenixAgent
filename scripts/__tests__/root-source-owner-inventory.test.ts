import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { $ } from "bun";
import {
  auditRootSourceOwners,
  compareRootOwnerInventoryMarkdown,
  findUnsafeDeleteDiagnostics,
  getRootOwnerTargetPath,
  listRootSourceFiles,
  renderRootOwnerInventoryMarkdown,
} from "../check-root-source-owner-inventory";
import {
  AmbiguousRootOwnerRuleError,
  getMostSpecificRootOwnerRule,
  RETAINED_HOST_TEST_RATIONALES,
  ROOT_OWNER_RULES,
  ROOT_OWNERS,
  type RootOwnerRule,
} from "../root-source-owner-rules";

// 清单中的每个最终 owner 都有至少一个明确迁移或删除规则。
test("覆盖 RootOwner 中的每个 owner", () => {
  const ownersWithRules = new Set(ROOT_OWNER_RULES.map((rule) => rule.owner));

  expect(ownersWithRules).toEqual(new Set(ROOT_OWNERS));
});

// 前缀是最长前缀匹配的唯一键，重复会使后续校验结果不确定。
test("不包含重复的规则 prefix", () => {
  const prefixes = ROOT_OWNER_RULES.map((rule) => rule.prefix);

  expect(new Set(prefixes).size).toBe(prefixes.length);
});

// 目录规则必须能归属其下的真实源文件。
test("最长前缀规则匹配目录下的文件", () => {
  expect(getMostSpecificRootOwnerRule("src/routes/acp/handler.ts")).toMatchObject({
    prefix: "src/routes/acp/",
    owner: "agent-runtime",
  });
});

// 具体文件规则必须覆盖同一路径的较短目录兜底规则。
test("最长 prefix 优先选择具体文件规则", () => {
  expect(getMostSpecificRootOwnerRule("src/routes/web/fs.ts")).toMatchObject({
    prefix: "src/routes/web/fs.ts",
    owner: "resource-machine",
  });
});

// 未列入清单的路径不能被错误归属。
test("无匹配规则时返回 undefined", () => {
  expect(getMostSpecificRootOwnerRule("scripts/check-root-source-owner-inventory.ts")).toBeUndefined();
});

// 清单枚举必须与实际根目录文件集一致，且提供稳定的 POSIX 排序。
test("列出排序后的根目录源码文件", async () => {
  const files = await listRootSourceFiles();

  const existingRoots: string[] = [];
  for (const root of ["src", "web"]) {
    if ((await $`test -d ${root}`.quiet().nothrow()).exitCode === 0) {
      existingRoots.push(root);
    }
  }
  let actualFileCount = 0;
  for (const root of existingRoots) {
    actualFileCount += Number((await $`find ${root} -type f | wc -l`.text()).trim());
  }
  expect(files.length).toBe(actualFileCount);
  expect(files).toEqual([...files].sort());
  expect(files.every((file) => file.startsWith("src/") || file.startsWith("web/"))).toBe(true);
  if (await Bun.file("src/.DS_Store").exists()) {
    expect(files).toContain("src/.DS_Store");
  }
});

// 已删除或尚未迁入的根目录不能让枚举器抛错，也不能回退扫描其他目录。
test("枚举器忽略不存在的根目录", async () => {
  const files = await listRootSourceFiles(["__root-owner-inventory-missing-src", "__root-owner-inventory-missing-web"]);

  expect(files).toEqual([]);
});

// 小文件集使未归属路径和汇总的处理不依赖当前仓库规模。
test("审计参数文件集并为每项记录唯一结果", async () => {
  const audit = await auditRootSourceOwners(["src/routes/web/fs.ts", "src/not-owned.ts"]);

  expect(audit.assignments.map((assignment) => assignment.file)).toEqual(["src/routes/web/fs.ts"]);
  expect(audit.unowned).toEqual(["src/not-owned.ts"]);
  expect(audit.ambiguous).toEqual([]);
  expect(audit.assignments.length + audit.unowned.length + audit.ambiguous.length).toBe(audit.files.length);
});

// 当前工作树中的每个实际文件只会产生一项归属、未归属或歧义结果。
test("审计当前根目录源码的归属", async () => {
  const audit = await auditRootSourceOwners();
  const files = await listRootSourceFiles();

  expect(audit.files).toEqual(files);
  expect(audit.unowned).toEqual([]);
  expect(audit.ambiguous).toEqual([]);
  expect(audit.assignments.length).toBe(files.length);
  expect(
    audit.assignments
      .filter((assignment) => assignment.rule.owner !== "delete")
      .every((assignment) => assignment.targetPath),
  ).toBe(true);
  expect(
    audit.assignments
      .filter((assignment) => assignment.rule.owner === "delete")
      .every((assignment) => assignment.targetPath === null),
  ).toBe(true);
  expect(
    audit.assignments.every(
      (assignment) =>
        assignment.consumers.length > 0 && !assignment.consumers.some((consumer) => consumer.includes("主装配边界")),
    ),
  ).toBe(true);
  expect(audit.assignments.every((assignment) => assignment.testOwner.length > 0)).toBe(true);
});

// i18n JSON 也是被前端代码和测试直接导入的模块，盘点不能只扫描 TypeScript 目标。
test("记录 JSON 资源的实际消费者与测试入口", async () => {
  const audit = await auditRootSourceOwners(["web/src/i18n/locales/en/components.json"]);
  const assignment = audit.assignments[0];

  expect(assignment?.consumers).toContain("apps/web/src/i18n/index.ts");
  expect(assignment?.testOwner).toContain("web/src/__tests__/message.ssr.test.tsx");
});

// 专属路径必须在通用 routes/components 规则前闭包到其领域模块。
test("专属文件优先归属其领域模块并推导精确目标路径", () => {
  const expectations = [
    [
      "src/routes/web/file-events.ts",
      "resource-machine",
      "RMD-02",
      "packages/resources/machine/src/routes/web/file-events.ts",
    ],
    [
      "web/components/ChatInterface.tsx",
      "chat-channel",
      "RMD-01",
      "packages/chat-channel/web/components/ChatInterface.tsx",
    ],
    [
      "web/src/pages/agent-panel/ChatArea.tsx",
      "chat-channel",
      "RMD-01",
      "packages/chat-channel/web/src/pages/agent-panel/ChatArea.tsx",
    ],
    [
      "web/src/components/agent-panel/SiteFrame.tsx",
      "agent-config",
      "RMD-05",
      "packages/resources/agent-config/web/components/agent-panel/SiteFrame.tsx",
    ],
    [
      "web/src/components/agent-panel/SiteTabsBar.tsx",
      "agent-config",
      "RMD-05",
      "packages/resources/agent-config/web/components/agent-panel/SiteTabsBar.tsx",
    ],
    ["web/src/api/request.ts", "apps-web", "RMD-08", "apps/web/src/api/request.ts"],
  ] as const;

  for (const [file, owner, task, targetPath] of expectations) {
    const rule = getMostSpecificRootOwnerRule(file);
    expect(rule).toMatchObject({ owner, task });
    expect(rule && getRootOwnerTargetPath(file, rule)).toBe(targetPath);
  }
});

// 专项测试跟随其直接被测的领域入口，不能被 __tests__ 宿主兜底吞没。
test("专项后端测试跟随领域 owner", () => {
  const expectations = [
    ["src/__tests__/chat-channel-action-translator.test.ts", "chat-channel", "RMD-01"],
    ["src/__tests__/chat-channel-browser-surface.test.ts", "chat-channel", "RMD-01"],
    ["src/__tests__/extract-acp-event.test.ts", "agent-runtime", "RMD-01"],
    ["src/__tests__/fs-symlink-escape.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/local-node-service.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/registry-service.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/round43-launch-spec-builder.test.ts", "agent-runtime", "RMD-01"],
    ["src/__tests__/round44-environments-routes.test.ts", "agent-runtime", "RMD-01"],
    ["src/__tests__/round44-launch-spec-builder-config.test.ts", "agent-runtime", "RMD-01"],
    ["src/__tests__/round45-environment-acp.test.ts", "agent-runtime", "RMD-01"],
    ["src/__tests__/machine-cleanup-node-dispatch.test.ts", "agent-runtime", "RMD-01"],
    ["src/transport/event-bus.ts", "agent-runtime", "RMD-01"],
  ] as const;

  for (const [file, owner, task] of expectations) {
    expect(getMostSpecificRootOwnerRule(file)).toMatchObject({ owner, task });
  }
});

// 继续锁定从 apps-server fallback 拆出的资源、配置和运行时专项测试。
test("剩余专项测试不落入 apps server fallback", () => {
  const expectations = [
    ["src/__tests__/api-agent-schema.test.ts", "agent-config", "RMD-04"],
    ["src/__tests__/sidebar-config-service.test.ts", "agent-config", "RMD-04"],
    ["src/__tests__/web-sidebar-config-routes.test.ts", "agent-config", "RMD-04"],
    ["src/__tests__/api-sandbox-schema.test.ts", "resource-sandbox", "RMD-03"],
    ["src/__tests__/api-sandbox-server.test.ts", "resource-sandbox", "RMD-03"],
    ["src/__tests__/fs-upload-escape.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/registry-filews-cleanup.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/registry-machine-stages.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/registry-routes-isolation.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/registry-routes.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/registry-schema.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/round19-registry-service-boundaries.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/instances-delete-idempotent.test.ts", "agent-runtime", "RMD-01"],
    ["src/__tests__/local-instance-death-cleanup.test.ts", "agent-runtime", "RMD-01"],
    ["src/__tests__/registry-environment-isolation-coverage.test.ts", "agent-runtime", "RMD-01"],
    ["src/__tests__/yjs-frontend-snapshot-persist.test.ts", "agent-runtime", "RMD-01"],
  ] as const;

  for (const [file, owner, task] of expectations) {
    expect(getMostSpecificRootOwnerRule(file)).toMatchObject({ owner, task });
  }
  expect(getMostSpecificRootOwnerRule("src/__tests__/architecture-check.test.ts")).toMatchObject({
    owner: "apps-server",
  });
});

// resource-permission repository 隔离测试跟随平台访问控制边界，而非 apps/server 宿主。
test("resource permission 测试归属平台访问控制", () => {
  for (const file of [
    "src/__tests__/round23-resource-permission-isolation.test.ts",
    "src/__tests__/round64-resource-permission-repository.test.ts",
  ]) {
    expect(getMostSpecificRootOwnerRule(file)).toMatchObject({ owner: "platform-access-control", task: "RMD-06" });
  }
});

// RMD-07 完成后根目录不再保留 host 测试，历史清单中的测试均迁入 apps/server。
test("RMD-07 host 测试完成迁入且不落入根目录 fallback", async () => {
  const expectations = [
    ["src/__tests__/round36-registry-service-coverage.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/round39-registry-service.test.ts", "resource-machine", "RMD-02"],
    ["src/__tests__/round68-registry-heartbeat.test.ts", "resource-machine", "RMD-02"],
    ["web/src/__tests__/acp-main-session-recovery.test.tsx", "chat-channel", "RMD-01"],
  ] as const;
  for (const [file, owner, task] of expectations)
    expect(getMostSpecificRootOwnerRule(file)).toMatchObject({ owner, task });

  const audit = await auditRootSourceOwners();
  const hostTests = audit.assignments.filter(
    (assignment) => assignment.rule.owner === "apps-server" && assignment.file.includes("__tests__/"),
  );
  expect(hostTests).toHaveLength(0);
  for (const source of Object.keys(RETAINED_HOST_TEST_RATIONALES)) {
    const target = getRootOwnerTargetPath(source, getMostSpecificRootOwnerRule(source)!);
    expect(existsSync(source), `legacy host test still exists: ${source}`).toBe(false);
    expect(existsSync(target), `migrated host test is missing: ${target}`).toBe(true);
  }
  expect(
    audit.assignments
      .filter((assignment) => assignment.rule.owner !== "apps-server")
      .every((assignment) => !assignment.hostRationale),
  ).toBe(true);
});

// Chat 专项前端测试应跟随实际 chat runtime/dataflow，而不是公共 web 测试目录。
test("chat 专项前端测试跟随运行时 owner", async () => {
  for (const file of [
    "web/src/__tests__/message.ssr.test.tsx",
    "web/src/__tests__/tool-semantic.test.ts",
    "web/src/__tests__/structured-to-thread.test.ts",
  ]) {
    expect(getMostSpecificRootOwnerRule(file)).toMatchObject({ task: "RMD-01" });
  }

  const audit = await auditRootSourceOwners();
  const hostTests = audit.assignments.filter(
    (assignment) => assignment.rule.owner === "apps-server" && assignment.file.includes("__tests__/"),
  );
  expect(hostTests).toHaveLength(0);
});

// 规则表自身是任务范围的稳定合同，不能由当前文件恰好为空而掩盖任务缺失。
test("规则表覆盖本轮九个迁移任务", () => {
  expect(new Set(ROOT_OWNER_RULES.map((rule) => rule.task))).toEqual(
    new Set(["RMD-01", "RMD-02", "RMD-03", "RMD-04", "RMD-05", "RMD-06", "RMD-07", "RMD-08", "RMD-09"]),
  );
});

// 规则选择器报告明确歧义时，审计保留路径和竞争规则而非将其视为未归属。
test("审计记录明确的最长前缀歧义", async () => {
  const competingRules = ROOT_OWNER_RULES.slice(0, 2);
  const audit = await auditRootSourceOwners(["src/ambiguous.ts"], () => {
    throw new AmbiguousRootOwnerRuleError("src/ambiguous.ts", competingRules);
  });

  expect(audit.ambiguous).toEqual([{ file: "src/ambiguous.ts", prefixes: competingRules.map((rule) => rule.prefix) }]);
});

// 选择器的非歧义故障必须冒泡，避免把实现错误伪装成归属冲突。
test("审计不会吞掉选择器的意外错误", async () => {
  await expect(
    auditRootSourceOwners(["src/failure.ts"], () => {
      throw new Error("unexpected selector failure");
    }),
  ).rejects.toThrow("unexpected selector failure");
});

// delete 不得指向 allowlist 外的源码路径，否则审计必须明确拒绝该分配。
test("审计拒绝删除 TypeScript 源文件", async () => {
  const deleteRule: RootOwnerRule = {
    prefix: "src/generated.ts",
    owner: "delete",
    targetRoot: null,
    task: "RMD-09",
    targetPrefix: "",
  };
  const audit = await auditRootSourceOwners(["src/generated.ts"], () => deleteRule);

  expect(findUnsafeDeleteDiagnostics([], [deleteRule])).toEqual([
    "delete rule src/generated.ts 不在 delete allowlist 内",
  ]);
  expect(audit.unsafeDeletes).toEqual(["delete assignment src/generated.ts 不在 delete allowlist 内"]);
});

// web/dist 是明确的构建产物目录，其 CSS 不属于 delete 安全护栏所说的源码。
test("审计允许删除 web dist 中的构建 CSS", async () => {
  const audit = await auditRootSourceOwners(["src/.DS_Store", "web/dist/assets/main.css"]);

  expect(audit.unsafeDeletes).toEqual([]);
});

// delete 是严格 allowlist：非产物路径即使不是常见源码扩展名也必须被拒绝。
test("审计拒绝 allowlist 外的 delete 规则和分配", () => {
  const invalidRules: RootOwnerRule[] = [
    {
      prefix: "web/generated.svg",
      owner: "delete",
      targetRoot: null,
      task: "RMD-09",
      targetPrefix: "",
    },
    {
      prefix: "src/unowned.txt",
      owner: "delete",
      targetRoot: null,
      task: "RMD-09",
      targetPrefix: "",
    },
  ];
  const assignments = invalidRules.map((rule) => ({ file: rule.prefix, rule }));

  expect(findUnsafeDeleteDiagnostics([], invalidRules)).toEqual([
    "delete rule web/generated.svg 不在 delete allowlist 内",
    "delete rule src/unowned.txt 不在 delete allowlist 内",
  ]);
  expect(findUnsafeDeleteDiagnostics(assignments)).toEqual([
    "delete assignment web/generated.svg 不在 delete allowlist 内",
    "delete assignment src/unowned.txt 不在 delete allowlist 内",
  ]);
});

// 文档不同步时比较器给出明确诊断，供 --check 阻止过期提交。
test("检测生成文档与审计结果不一致", () => {
  expect(compareRootOwnerInventoryMarkdown("expected", "outdated")).toContain("根目录源码归属清单不同步");
  expect(compareRootOwnerInventoryMarkdown("expected", "expected")).toBeUndefined();
});

// 生成的 Markdown 是可审查的完整清单，而不是仅供机器读取的汇总。
test("渲染根目录源码归属 Markdown 清单", async () => {
  const markdown = renderRootOwnerInventoryMarkdown(await auditRootSourceOwners());

  expect(markdown).toContain("文件总数");
  expect(markdown).toContain("RMD-01");
  expect(markdown).toContain("RMD-09");
  expect(markdown).toContain("delete");
  expect(markdown).toContain("## 逐文件映射");
  expect(markdown).toContain("src/routes/web/file-events.ts");
});
