import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChannelBindingRow } from "../repositories/channel-binding";
import { channelBindingRepo } from "../repositories/channel-binding";
import {
  createBinding,
  deleteBinding,
  findBindingForMessage,
  getBinding,
  listBindings,
  updateBinding,
} from "../services/channel-binding";

const NOW = new Date("2026-08-19T00:00:00.000Z");

function row(overrides: Partial<ChannelBindingRow> = {}): ChannelBindingRow {
  return {
    id: "binding-1",
    platform: "feishu",
    chatId: "chat-1",
    agentId: "agent-1",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const originals = {
  create: channelBindingRepo.create,
  delete: channelBindingRepo.delete,
  getById: channelBindingRepo.getById,
  list: channelBindingRepo.list,
  listByPlatformAndEnabled: channelBindingRepo.listByPlatformAndEnabled,
  update: channelBindingRepo.update,
};

function restoreRepo() {
  channelBindingRepo.create = originals.create;
  channelBindingRepo.delete = originals.delete;
  channelBindingRepo.getById = originals.getById;
  channelBindingRepo.list = originals.list;
  channelBindingRepo.listByPlatformAndEnabled = originals.listByPlatformAndEnabled;
  channelBindingRepo.update = originals.update;
}

describe("round58 通道绑定服务内存隔离", () => {
  beforeEach(restoreRepo);
  afterEach(restoreRepo);

  // 空内存平台配置不得生成虚假绑定。
  test("空配置列表返回空数组", async () => {
    channelBindingRepo.list = mock(async () => []);
    await expect(listBindings()).resolves.toEqual([]);
  });

  // 列表必须保留仓储配置的顺序。
  test("列表保留平台配置顺序", async () => {
    channelBindingRepo.list = mock(async () => [row({ id: "first" }), row({ id: "second" })]);
    await expect(listBindings()).resolves.toMatchObject([{ id: "first" }, { id: "second" }]);
  });

  // wildcard 配置必须以 null 暴露给调用者。
  test("列表标准化 wildcard chatId", async () => {
    channelBindingRepo.list = mock(async () => [row({ chatId: null })]);
    await expect(listBindings()).resolves.toMatchObject([{ chatId: null }]);
  });

  // 服务返回的列表项不得携带仓储时间戳等内部字段。
  test("列表脱离仓储内部字段", async () => {
    channelBindingRepo.list = mock(async () => [row()]);
    const [binding] = await listBindings();
    expect(binding).toEqual({
      id: "binding-1",
      platform: "feishu",
      chatId: "chat-1",
      agentId: "agent-1",
      enabled: true,
    });
  });

  // 返回对象必须与内存行隔离，防止调用方改写缓存配置。
  test("列表结果与内存行隔离", async () => {
    const stored = row();
    channelBindingRepo.list = mock(async () => [stored]);
    const [binding] = await listBindings();
    binding.enabled = false;
    expect(stored.enabled).toBeTrue();
  });

  // 查询缺失绑定时必须明确返回 undefined。
  test("读取缺失绑定返回 undefined", async () => {
    channelBindingRepo.getById = mock(async () => null);
    await expect(getBinding("missing")).resolves.toBeUndefined();
  });

  // 单条读取必须保留平台标识，避免跨平台误派发。
  test("读取保留平台标识", async () => {
    channelBindingRepo.getById = mock(async () => row({ platform: "wechat" }));
    await expect(getBinding("binding-1")).resolves.toMatchObject({ platform: "wechat" });
  });

  // 单条读取必须保留禁用状态，供调用方阻断派发。
  test("读取保留禁用状态", async () => {
    channelBindingRepo.getById = mock(async () => row({ enabled: false }));
    await expect(getBinding("binding-1")).resolves.toMatchObject({ enabled: false });
  });

  // 单条读取结果也必须与内存行隔离。
  test("读取结果与内存行隔离", async () => {
    const stored = row();
    channelBindingRepo.getById = mock(async () => stored);
    const binding = await getBinding("binding-1");
    if (!binding) throw new Error("预期存在绑定");
    binding.agentId = "changed-agent";
    expect(stored.agentId).toBe("agent-1");
  });

  // 未指定 enabled 时新绑定必须默认启用。
  test("创建默认启用", async () => {
    const create = mock(async (input) => row(input));
    channelBindingRepo.create = create;
    await expect(createBinding({ platform: "feishu", agentId: "agent-2" })).resolves.toMatchObject({ enabled: true });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  // 未指定 chatId 时新绑定必须成为 wildcard。
  test("创建默认使用 wildcard", async () => {
    channelBindingRepo.create = mock(async (input) => row(input));
    await expect(createBinding({ platform: "feishu", agentId: "agent-2" })).resolves.toMatchObject({ chatId: null });
  });

  // 显式禁用必须优先于默认启用策略。
  test("创建保留显式禁用", async () => {
    channelBindingRepo.create = mock(async (input) => row(input));
    await expect(createBinding({ platform: "feishu", agentId: "agent-2", enabled: false })).resolves.toMatchObject({
      enabled: false,
    });
  });

  // 精确 chatId 不能被服务篡改或脱敏。
  test("创建保留精确 chatId", async () => {
    channelBindingRepo.create = mock(async (input) => row(input));
    await expect(
      createBinding({ platform: "feishu", chatId: "chat-private", agentId: "agent-2" }),
    ).resolves.toMatchObject({
      chatId: "chat-private",
    });
  });

  // 创建请求应为审计字段生成两个 Date 时间戳。
  test("创建写入时间戳", async () => {
    const create = mock(async (input) => row(input));
    channelBindingRepo.create = create;
    await createBinding({ platform: "feishu", agentId: "agent-2" });
    const [input] = create.mock.calls[0];
    expect(input.createdAt).toBeInstanceOf(Date);
    expect(input.updatedAt).toBeInstanceOf(Date);
    expect(input.createdAt).toEqual(input.updatedAt);
  });

  // 仓储创建失败必须原样抛出，不可伪造成功配置。
  test("创建透传仓储错误", async () => {
    channelBindingRepo.create = mock(async () => {
      throw new Error("create failed");
    });
    await expect(createBinding({ platform: "feishu", agentId: "agent-2" })).rejects.toThrow("create failed");
  });

  // 删除成功状态必须透传给上层路由。
  test("删除透传成功状态", async () => {
    channelBindingRepo.delete = mock(async () => true);
    await expect(deleteBinding("binding-1")).resolves.toBeTrue();
  });

  // 删除不存在项不得伪造成功。
  test("删除透传缺失状态", async () => {
    channelBindingRepo.delete = mock(async () => false);
    await expect(deleteBinding("missing")).resolves.toBeFalse();
  });

  // 删除错误必须透传，避免调用方误以为隔离已完成。
  test("删除透传仓储错误", async () => {
    channelBindingRepo.delete = mock(async () => {
      throw new Error("delete failed");
    });
    await expect(deleteBinding("binding-1")).rejects.toThrow("delete failed");
  });

  // 更新缺失项时不得触发写入。
  test("更新缺失项不写入", async () => {
    const update = mock(async () => undefined);
    channelBindingRepo.getById = mock(async () => null);
    channelBindingRepo.update = update;
    await expect(updateBinding("missing", { enabled: false })).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  // 更新只应传递指定字段及新的更新时间。
  test("更新合并指定字段与时间戳", async () => {
    const update = mock(async () => undefined);
    channelBindingRepo.getById = mock(async () => row());
    channelBindingRepo.update = update;
    await updateBinding("binding-1", { chatId: "chat-new" });
    expect(update).toHaveBeenCalledWith(
      "binding-1",
      expect.objectContaining({ chatId: "chat-new", updatedAt: expect.any(Date) }),
    );
  });

  // 更新写入失败时不得读取并泄露伪造最终状态。
  test("更新失败不重新读取", async () => {
    const getById = mock(async () => row());
    channelBindingRepo.getById = getById;
    channelBindingRepo.update = mock(async () => {
      throw new Error("update failed");
    });
    await expect(updateBinding("binding-1", { enabled: false })).rejects.toThrow("update failed");
    expect(getById).toHaveBeenCalledTimes(1);
  });

  // 更新后必须重读内存平台配置的最终状态。
  test("更新后返回最终持久化状态", async () => {
    const getById = mock(async () => row());
    getById.mockImplementationOnce(async () => row());
    getById.mockImplementationOnce(async () => row({ enabled: false, chatId: "chat-final" }));
    channelBindingRepo.getById = getById;
    channelBindingRepo.update = mock(async () => undefined);
    await expect(updateBinding("binding-1", { enabled: false })).resolves.toMatchObject({
      enabled: false,
      chatId: "chat-final",
    });
  });

  // 精确平台与 chatId 匹配必须优先于 wildcard。
  test("消息优先匹配精确绑定", async () => {
    channelBindingRepo.listByPlatformAndEnabled = mock(async () => [
      row({ id: "wildcard", chatId: null }),
      row({ id: "exact" }),
    ]);
    await expect(findBindingForMessage("feishu", "chat-1")).resolves.toMatchObject({
      matchType: "exact",
      binding: { id: "exact" },
    });
  });

  // 无精确匹配时才允许使用 wildcard。
  test("消息回退匹配 wildcard", async () => {
    channelBindingRepo.listByPlatformAndEnabled = mock(async () => [row({ chatId: null })]);
    await expect(findBindingForMessage("feishu", "other-chat")).resolves.toMatchObject({ matchType: "wildcard" });
  });

  // 没有可用平台配置时不得选择任何 agent。
  test("消息无候选时返回 undefined", async () => {
    channelBindingRepo.listByPlatformAndEnabled = mock(async () => []);
    await expect(findBindingForMessage("feishu", "chat-1")).resolves.toBeUndefined();
  });

  // 匹配必须使用请求的平台名查询，防止跨平台绑定泄漏。
  test("消息按请求平台隔离查询", async () => {
    const listByPlatformAndEnabled = mock(async () => []);
    channelBindingRepo.listByPlatformAndEnabled = listByPlatformAndEnabled;
    await findBindingForMessage("wechat", "chat-1");
    expect(listByPlatformAndEnabled).toHaveBeenCalledWith("wechat");
  });

  // 多个精确规则时保持仓储优先级，避免服务重排安全策略。
  test("消息保留首个精确规则优先级", async () => {
    channelBindingRepo.listByPlatformAndEnabled = mock(async () => [row({ id: "first" }), row({ id: "second" })]);
    await expect(findBindingForMessage("feishu", "chat-1")).resolves.toMatchObject({ binding: { id: "first" } });
  });

  // 匹配结果必须与内存候选隔离，避免调用方改写后续路由决策。
  test("匹配结果与内存候选隔离", async () => {
    const stored = row();
    channelBindingRepo.listByPlatformAndEnabled = mock(async () => [stored]);
    const result = await findBindingForMessage("feishu", "chat-1");
    if (!result) throw new Error("预期存在匹配");
    result.binding.enabled = false;
    expect(stored.enabled).toBeTrue();
  });

  // 平台配置读取错误必须透传，不能将故障误报为空配置。
  test("消息匹配透传仓储错误", async () => {
    channelBindingRepo.listByPlatformAndEnabled = mock(async () => {
      throw new Error("platform lookup failed");
    });
    await expect(findBindingForMessage("feishu", "chat-1")).rejects.toThrow("platform lookup failed");
  });
});
