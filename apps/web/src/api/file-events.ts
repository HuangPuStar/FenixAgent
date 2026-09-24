/**
 * file-events.ts — 文件树变更事件的 WebSocket 域模块（前端规范 §8.1 通道二）。
 *
 * 归属：`/web/file-events` 与 `/web/environments/:id/fs` 同属宿主的 workspace/fs 域，因此
 * 通道建模落在宿主 `api/` 层（§5.1「宿主专有域」）。**URL 拼装必须在本模块完成**：
 * §5.8 禁止在组件中拼装后端 URL（含 WebSocket URL），组件只消费本模块的入口。
 *
 * 组织参数：WS 握手无法携带 `X-Active-Org-Id` 头，只能在 query 里带组织 id。该值经
 * `@fenix/web-runtime/lib/active-org` 的契约读取（§3.3 的唯一读取点），本模块不得自行
 * `localStorage.getItem`。
 *
 * 连接生命周期（重连退避、页面可见性、失效去抖）**不在本模块**：它属于调用方的策略，
 * 本模块只负责「打开一条通道 + 解析帧语义」。服务端帧协议见 `docs/arch/12-files.md` §4.3。
 */

import { readActiveOrgId } from "@fenix/web-runtime/lib/active-org";

/** 服务端推给客户端的帧类型（`file_changed_batch` 与 `file_changed` 对调用方语义相同）。 */
export type FileEventsFrameKind = "invalidate_all" | "file_changed";

/** 归一化后的文件事件帧：只保留调用方做失效去抖需要的判别字段。 */
export interface FileEventsFrame {
  kind: FileEventsFrameKind;
  /** 事件所属 environment；已由本模块按订阅目标过滤，调用方无需再比对。 */
  environmentId: string;
}

export interface FileEventsHandlers {
  /** 连接打开且订阅帧已发出（调用方据此清零退避计数）。 */
  onOpen: () => void;
  /** 收到归属于本连接的 environment 的变更帧。 */
  onFrame: (frame: FileEventsFrame) => void;
  /** 连接关闭（含调用 `close()` 主动关闭）；是否重连由调用方决定。 */
  onClose: () => void;
}

export interface FileEventsConnection {
  /** 连接是否处于 OPEN（调用方据此判断"已有可用连接"）。 */
  isOpen: () => boolean;
  /** 主动关闭连接。 */
  close: () => void;
}

/** 构造 `/web/file-events` 的 WS URL（含组织参数）；导出供测试与诊断使用。 */
export function buildFileEventsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}/web/file-events`;
  const organizationId = readActiveOrgId();
  return organizationId ? `${base}?active_org_id=${encodeURIComponent(organizationId)}` : base;
}

/**
 * 打开一条文件事件通道。每次调用都会新建底层 WebSocket；复用与替换由调用方通过
 * `isOpen()` / `close()` 决定（不在这里做连接池，避免第二个连接所有者）。
 */
export function openFileEventsConnection(environmentId: string, handlers: FileEventsHandlers): FileEventsConnection {
  const socket = new WebSocket(buildFileEventsUrl());

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "subscribe", environments: [environmentId] }));
    handlers.onOpen();
  };

  socket.onmessage = (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as { type?: string; environment_id?: string };
      if (frame.environment_id !== environmentId) return;
      if (frame.type === "invalidate_all") {
        handlers.onFrame({ kind: "invalidate_all", environmentId });
      } else if (frame.type === "file_changed" || frame.type === "file_changed_batch") {
        handlers.onFrame({ kind: "file_changed", environmentId });
      }
    } catch (error) {
      // 后台推送路径：畸形帧只影响本次刷新（§5.8 三类豁免之一），保留诊断上下文即可。
      console.error("Invalid file-events frame:", error);
    }
  };

  socket.onclose = () => {
    handlers.onClose();
  };

  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    close: () => socket.close(),
  };
}
