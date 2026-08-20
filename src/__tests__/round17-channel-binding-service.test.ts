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

function binding(overrides: Partial<ChannelBindingRow> = {}): ChannelBindingRow {
  return {
    id: "binding-1",
    platform: "telegram",
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

describe("Channel binding 服务的状态与消息匹配", () => {
  beforeEach(() => {
    channelBindingRepo.create = originals.create;
    channelBindingRepo.delete = originals.delete;
    channelBindingRepo.getById = originals.getById;
    channelBindingRepo.list = originals.list;
    channelBindingRepo.listByPlatformAndEnabled = originals.listByPlatformAndEnabled;
    channelBindingRepo.update = originals.update;
  });

  afterEach(() => {
    channelBindingRepo.create = originals.create;
    channelBindingRepo.delete = originals.delete;
    channelBindingRepo.getById = originals.getById;
    channelBindingRepo.list = originals.list;
    channelBindingRepo.listByPlatformAndEnabled = originals.listByPlatformAndEnabled;
    channelBindingRepo.update = originals.update;
  });

  // 列表应把数据库的空 chatId 标准化为显式 wildcard 值。
  test("列表映射空 chatId", async () => {
    channelBindingRepo.list = mock(async () => [binding({ chatId: null })]);
    await expect(listBindings()).resolves.toEqual([
      { id: "binding-1", platform: "telegram", chatId: null, agentId: "agent-1", enabled: true },
    ]);
  });

  // 空列表必须保持为空，不以伪造绑定替代。
  test("列表保留空结果", async () => {
    channelBindingRepo.list = mock(async () => []);
    await expect(listBindings()).resolves.toEqual([]);
  });

  // 单条查询不存在时不得暴露内部数据库形态。
  test("读取不存在绑定返回 undefined", async () => {
    channelBindingRepo.getById = mock(async () => null) as never;
    await expect(getBinding("missing")).resolves.toBeUndefined();
  });

  // 单条查询应保留禁用状态，供调用方避免错误派发。
  test("读取绑定保留禁用状态", async () => {
    channelBindingRepo.getById = mock(async () => binding({ enabled: false }));
    await expect(getBinding("binding-1")).resolves.toMatchObject({ enabled: false });
  });

  // 创建未给 enabled 时默认启用，避免产生永不匹配的绑定。
  test("创建绑定默认启用", async () => {
    const create = mock(async (input: ChannelBindingRow) => binding(input));
    channelBindingRepo.create = create;
    await expect(createBinding({ platform: "slack", agentId: "agent-2" })).resolves.toMatchObject({
      platform: "slack",
      chatId: null,
      enabled: true,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ chatId: null, enabled: true }));
  });

  // 创建应显式保留调用方的禁用状态。
  test("创建绑定允许显式禁用", async () => {
    channelBindingRepo.create = mock(async (input: ChannelBindingRow) => binding(input));
    await expect(
      createBinding({ platform: "slack", chatId: "chat-2", agentId: "agent-2", enabled: false }),
    ).resolves.toMatchObject({
      chatId: "chat-2",
      enabled: false,
    });
  });

  // 删除结果必须透传，供路由区分不存在与已删除。
  test("删除绑定透传仓储结果", async () => {
    channelBindingRepo.delete = mock(async () => false);
    await expect(deleteBinding("missing")).resolves.toBe(false);
  });

  // 更新不存在对象时不得发起写操作。
  test("更新不存在绑定不写入", async () => {
    const update = mock(async () => undefined);
    channelBindingRepo.getById = mock(async () => null) as never;
    channelBindingRepo.update = update;
    await expect(updateBinding("missing", { enabled: false })).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  // 更新后应重新读取，返回数据库最终状态而非输入回显。
  test("更新后重新读取最终状态", async () => {
    const getById = mock(async () => binding());
    getById.mockImplementationOnce(async () => binding());
    getById.mockImplementationOnce(async () => binding({ chatId: "chat-new", enabled: false }));
    channelBindingRepo.getById = getById;
    channelBindingRepo.update = mock(async () => undefined);
    await expect(updateBinding("binding-1", { chatId: "chat-new", enabled: false })).resolves.toMatchObject({
      chatId: "chat-new",
      enabled: false,
    });
  });

  // 精确 chatId 匹配必须优先于 wildcard，防止消息被错误 agent 接管。
  test("消息优先匹配精确绑定", async () => {
    channelBindingRepo.listByPlatformAndEnabled = mock(async () => [
      binding({ chatId: null }),
      binding({ id: "exact", chatId: "chat-1" }),
    ]);
    await expect(findBindingForMessage("telegram", "chat-1")).resolves.toMatchObject({
      matchType: "exact",
      binding: { id: "exact" },
    });
  });

  // 没有精确绑定时才可回退到平台级 wildcard。
  test("消息回退匹配 wildcard", async () => {
    channelBindingRepo.listByPlatformAndEnabled = mock(async () => [binding({ chatId: null })]);
    await expect(findBindingForMessage("telegram", "chat-other")).resolves.toMatchObject({ matchType: "wildcard" });
  });

  // 空候选集不得误匹配到其他平台的绑定。
  test("不同平台无候选时不匹配", async () => {
    channelBindingRepo.listByPlatformAndEnabled = mock(async () => []);
    await expect(findBindingForMessage("discord", "chat-1")).resolves.toBeUndefined();
  });

  // 禁用绑定由仓储过滤后不得参与消息匹配。
  test("禁用绑定不参与匹配", async () => {
    const listByPlatformAndEnabled = mock(async () => []);
    channelBindingRepo.listByPlatformAndEnabled = listByPlatformAndEnabled;
    await expect(findBindingForMessage("telegram", "chat-1")).resolves.toBeUndefined();
    expect(listByPlatformAndEnabled).toHaveBeenCalledWith("telegram");
  });
});
