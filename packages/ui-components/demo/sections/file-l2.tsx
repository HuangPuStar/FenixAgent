import { Badge, Button, FileTreeInputDialog } from "@fenix/ui-components";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * File L2 分区：树交互层 —— 叠在文件树上的新建 / 重命名对话框。
 *
 * 这一层的边界是「弹窗结构 + 提交事件」：FileTreeInputDialog 只渲染单字段对话框，
 * 字段值、校验错误与 submitting 状态全部由调用方持有。宿主在树的右键菜单里打开它
 * （源仓库的 FileTreeTab 按 newFolder / rename 等 kind 派生 title 与 description），
 * 名字合法性（空值、重名、非法字符）也由宿主判断 —— 这里的必填校验和提交延迟都在本文件内模拟。
 *
 * 两组示例不共享实现：新建与重命名各有独立的字段状态与 pending 句柄，模拟提交的最小实现
 * （useSimulatedPending）在本文件内单独写一份，不从其他分区导入，避免示例之间出现隐式耦合。
 */

/** 模拟一次异步提交的耗时；接入真实业务时替换为 fs API 的 Promise 即可，其余演示逻辑不变。 */
const SIMULATED_LATENCY_MS = 1200;

/**
 * 演示用的「异步提交」状态：进入 pending，1.2s 后复位并执行完成回调。
 *
 * demo 没有后端，只能靠定时器展示 loading；句柄存在 ref 中并在卸载时清理，避免切换分区或 HMR
 * 后向已卸载组件写入状态。pending 期间重复触发会被忽略，防止定时器叠加导致回调执行多次。
 */
function useSimulatedPending(): { pending: boolean; start: (onSettled?: () => void) => void } {
  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  function start(onSettled?: () => void) {
    if (timerRef.current !== null) return;
    setPending(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPending(false);
      onSettled?.();
    }, SIMULATED_LATENCY_MS);
  }

  return { pending, start };
}

export function FileL2Section() {
  const { t } = useTranslation(DEMO_NS);

  const [createOpen, setCreateOpen] = useState(false);
  const [createValue, setCreateValue] = useState("");
  const [createError, setCreateError] = useState<string | undefined>(undefined);
  const [createdName, setCreatedName] = useState<string | null>(null);
  const create = useSimulatedPending();

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | undefined>(undefined);
  const [renamedTo, setRenamedTo] = useState<string | null>(null);
  const rename = useSimulatedPending();

  // 提交交给宿主：这里只做必填校验，pending 期间按钮禁用由组件的 submitting 控制。
  const handleCreateSubmit = () => {
    if (!createValue.trim()) {
      setCreateError("Name is required.");
      return;
    }
    create.start(() => {
      setCreateOpen(false);
      setCreatedName(createValue);
    });
  };

  const handleRenameSubmit = () => {
    if (!renameValue.trim()) {
      setRenameError("Name is required.");
      return;
    }
    rename.start(() => {
      setRenameOpen(false);
      setRenamedTo(renameValue);
    });
  };

  return (
    <section>
      <h1 data-slot="demo-section-title" className="mb-6 text-[24px] font-semibold">
        {t("sections.fileL2")}
      </h1>
      <p className="mt-3 text-text-muted text-[12px]">{t("sectionHints.fileL2")}</p>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          FileTreeInputDialog — New folder
        </h2>
        <p className="mt-3 text-text-muted text-[12px]">
          宿主从树的右键菜单（<code>onNewFolder</code>）打开这个弹窗；标题与说明由宿主按操作类型派生，
          名字合法性也由宿主校验 —— 组件不做文件系统判断，只负责弹窗结构与提交事件。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => setCreateOpen(true)}>
            New folder
          </Button>
          {createdName === null ? null : <Badge variant="secondary">Created: {createdName}</Badge>}
        </div>
        {/* 字段状态、错误与异步提交都由调用方持有，组件只负责弹窗结构与提交事件。 */}
        <FileTreeInputDialog
          open={createOpen}
          title="New folder"
          description="Folder name is validated by the host before submitting."
          value={createValue}
          error={createError}
          submitting={create.pending}
          confirmLabel="Create"
          cancelLabel="Cancel"
          onValueChange={(value) => {
            setCreateValue(value);
            setCreateError(undefined);
          }}
          onOpenChange={(open) => {
            if (!create.pending) setCreateOpen(open);
          }}
          onSubmit={handleCreateSubmit}
        />
        <p className="mt-3 text-text-muted text-[12px]">
          直接点 Create 会走必填校验（<code>error</code> prop 渲染在输入框下方）；填入名字后提交进入 1.2s 的
          pending，期间确认与取消按钮一并禁用，模拟请求结束后关闭弹窗。
        </p>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          FileTreeInputDialog — Rename
        </h2>
        <p className="mt-3 text-text-muted text-[12px]">
          同一个组件的改名流程：宿主从右键菜单（<code>onRenameRequest</code>）带着原名字打开，
          <code>title</code> / <code>confirmLabel</code> 换成 Rename；重名、非法字符这类判断同样由宿主给出，
          校验失败时只回填 <code>error</code>，弹窗保持打开。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            onClick={() => {
              setRenameValue("idea.md");
              setRenameError(undefined);
              setRenameOpen(true);
            }}
          >
            Rename item
          </Button>
          {renamedTo === null ? null : <Badge variant="secondary">Renamed to: {renamedTo}</Badge>}
        </div>
        <FileTreeInputDialog
          open={renameOpen}
          title="Rename"
          description="The new name is validated by the host before submitting."
          value={renameValue}
          error={renameError}
          submitting={rename.pending}
          confirmLabel="Rename"
          cancelLabel="Cancel"
          onValueChange={(value) => {
            setRenameValue(value);
            setRenameError(undefined);
          }}
          onOpenChange={(open) => {
            if (!rename.pending) setRenameOpen(open);
          }}
          onSubmit={handleRenameSubmit}
        />
        <p className="mt-3 text-text-muted text-[12px]">
          pending 期间 <code>onOpenChange</code> 的关闭请求被忽略，避免提交中通过 Esc / 遮罩关掉弹窗。
        </p>
      </div>
    </section>
  );
}
