import type { AcpConnectionAdapter } from "acp-link";
import { OPENCODE_AGENT_NAME } from "./runtime-config";

type AcpConnection = Parameters<AcpConnectionAdapter>[0];
type RestoredSession = Awaited<ReturnType<AcpConnection["loadSession"]>>;

/** 保留引擎返回的原始模式值，避免显示层回退掩盖已删除的 Agent。 */
function readSessionModes(result: RestoredSession): RestoredSession["modes"] {
  if (result.modes) return result.modes;
  const option = result.configOptions?.find(
    (entry) => entry.type === "select" && (entry.id === "mode" || entry.category === "mode"),
  );
  if (option?.type !== "select") return null;
  const choices = option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
  return {
    currentModeId: option.currentValue,
    availableModes: choices.map((entry) => ({ id: entry.value, name: entry.name, description: entry.description })),
  };
}

/**
 * 历史会话恢复的唯一入口：OpenCode 曾把平台 Agent 名保存为模式键，旧键失效时切到固定 fenix。
 * 仅适用于 OpenCode；存量会话完成迁移后可移除此适配。
 */
export function adaptOpencodeConnection(connection: AcpConnection): AcpConnection {
  /** 只有旧 Agent 已失效时才切换模式，并在引擎确认后返回恢复成功。 */
  async function recover(result: RestoredSession, sessionId: string): Promise<RestoredSession> {
    const modes = readSessionModes(result);
    if (!modes?.currentModeId || modes.availableModes.some((mode) => mode.id === modes.currentModeId)) return result;
    if (!modes.availableModes.some((mode) => mode.id === OPENCODE_AGENT_NAME)) {
      throw new Error("The instance default mode is unavailable during session recovery");
    }

    // OpenCode 在历史会话中保存 Agent 名；仅修正响应不能改变后续 prompt 使用的模式。
    await connection.setSessionMode({ sessionId, modeId: OPENCODE_AGENT_NAME });
    return {
      ...result,
      modes: { ...modes, currentModeId: OPENCODE_AGENT_NAME },
      configOptions: result.configOptions?.map((option) =>
        option.type === "select" && (option.id === "mode" || option.category === "mode")
          ? { ...option, currentValue: OPENCODE_AGENT_NAME }
          : option,
      ),
    };
  }

  const methods: Pick<AcpConnection, "loadSession" | "resumeSession"> = {
    loadSession: async (params) => recover(await connection.loadSession(params), params.sessionId),
    resumeSession: async (params) => recover(await connection.resumeSession(params), params.sessionId),
  };
  return new Proxy(connection, {
    get(target, property) {
      if (property === "loadSession" || property === "resumeSession") return methods[property];
      const value = Reflect.get(target, property, target);
      // SDK 的其他方法仍在原始对象上执行，保留私有字段和生命周期状态。
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
