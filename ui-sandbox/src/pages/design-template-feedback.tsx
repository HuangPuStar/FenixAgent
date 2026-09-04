import { AlertTriangle, Inbox, Pencil, Play, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal, PrimaryButton } from "../components/ui";

type DemoPageState = "loading" | "empty" | "error";

export function PageStatesTemplate() {
  const [state, setState] = useState<DemoPageState>("loading");
  return (
    <div className="template-page-states">
      <div className="segmented" role="group" aria-label="页面状态示例">
        {[
          ["loading", "加载"],
          ["empty", "空结果"],
          ["error", "错误"],
        ].map(([value, label]) => (
          <button
            type="button"
            className={state === value ? "is-active" : ""}
            aria-pressed={state === value}
            onClick={() => setState(value as DemoPageState)}
            key={value}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="template-page-state" aria-live="polite">
        {state === "loading" && (
          <div className="template-skeletons" role="status" aria-label="正在加载">
            <span />
            <span />
            <span />
          </div>
        )}
        {state === "empty" && (
          <div>
            <Inbox />
            <strong>暂无匹配结果</strong>
            <span>调整搜索条件，或创建第一个资源。</span>
            <PrimaryButton>创建资源</PrimaryButton>
          </div>
        )}
        {state === "error" && (
          <div>
            <AlertTriangle />
            <strong>资源加载失败</strong>
            <span>连接已中断，请检查网络后重试。</span>
            <button className="button" type="button" onClick={() => setState("loading")}>
              <RefreshCw /> 重试
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function OverlayTemplate() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  useEffect(() => {
    if (!drawerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [drawerOpen]);
  return (
    <div className="template-overlay-actions">
      <button className="button" type="button" onClick={() => setDrawerOpen(true)}>
        <Pencil /> 打开编辑抽屉
      </button>
      <button className="button button--danger" type="button" onClick={() => setModalOpen(true)}>
        <Trash2 /> 打开删除确认
      </button>
      <button className="button button--ghost" type="button">
        <Play /> 普通页面操作
      </button>

      {drawerOpen && (
        <div
          className="template-drawer-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDrawerOpen(false);
          }}
        >
          <aside className="template-drawer" role="dialog" aria-modal="true" aria-label="编辑服务商">
            <header>
              <div>
                <strong>编辑服务商</strong>
                <span>更新连接与凭证引用</span>
              </div>
              <button type="button" aria-label="关闭抽屉" onClick={() => setDrawerOpen(false)}>
                <X />
              </button>
            </header>
            <div className="template-drawer__body">
              <label>
                名称
                <input defaultValue="OpenAI Production" />
              </label>
              <label>
                Endpoint
                <input defaultValue="https://api.openai.com/v1" />
              </label>
              <label>
                密钥引用
                <input defaultValue="{env:RCS_SECRET_OPENAI}" />
              </label>
            </div>
            <footer>
              <button className="button" type="button" onClick={() => setDrawerOpen(false)}>
                取消
              </button>
              <button className="button button--primary" type="button" onClick={() => setDrawerOpen(false)}>
                保存更改
              </button>
            </footer>
          </aside>
        </div>
      )}

      {modalOpen && (
        <Modal
          title="删除服务商？"
          onClose={() => setModalOpen(false)}
          onConfirm={() => setModalOpen(false)}
          confirmText="确认删除"
        >
          <p className="template-confirm-copy">删除后，引用该服务商的模型将不可用。此操作仅影响当前沙盒示例。</p>
        </Modal>
      )}
    </div>
  );
}
