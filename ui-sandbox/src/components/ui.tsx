import { Check, MoreHorizontal, Plus, Search, X } from "lucide-react";
import { type ReactNode, useEffect } from "react";

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header__copy">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

export function PrimaryButton({ children = "新建", onClick }: { children?: ReactNode; onClick?: () => void }) {
  return (
    <button className="button button--primary" type="button" onClick={onClick}>
      <Plus />
      {children}
    </button>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder = "搜索",
  shortcut,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  shortcut?: string;
}) {
  return (
    <label className="search-field">
      <Search />
      <input
        aria-label={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {shortcut && <kbd>{shortcut}</kbd>}
    </label>
  );
}

export function SearchToolbar({
  value,
  onChange,
  placeholder,
  shortcut,
  className,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  shortcut?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={`search-toolbar${className ? ` ${className}` : ""}`} aria-label="搜索与筛选">
      <SearchField value={value} onChange={onChange} placeholder={placeholder} shortcut={shortcut} />
      {children}
    </section>
  );
}

export function ToolbarSummary({ children }: { children: ReactNode }) {
  return <div className="toolbar-summary">{children}</div>;
}

export function Status({
  kind = "success",
  children,
}: {
  kind?: "success" | "warning" | "danger" | "default";
  children: ReactNode;
}) {
  return <span className={`status${kind === "default" ? "" : ` status--${kind}`}`}>{children}</span>;
}

export function Tag({ children, tone }: { children: ReactNode; tone?: "blue" | "green" | "amber" }) {
  return <span className={`tag${tone ? ` tag--${tone}` : ""}`}>{children}</span>;
}

export function RowMenu() {
  return (
    <button className="kebab" type="button" aria-label="更多操作">
      <MoreHorizontal />
    </button>
  );
}

export function Modal({
  title,
  children,
  onClose,
  onConfirm,
  confirmText = "保存",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onConfirm?: () => void;
  confirmText?: string;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__header">
          <h3>{title}</h3>
          <button className="icon-button" type="button" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="modal__body">{children}</div>
        <footer className="modal__footer">
          <button className="button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button button--primary" type="button" onClick={onConfirm ?? onClose}>
            {confirmText}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function Toast({ text }: { text: string }) {
  return (
    <div className="toast" role="status">
      <Check />
      {text}
    </div>
  );
}

export function FormFields({ kind }: { kind: string }) {
  return (
    <>
      <div className="field">
        <label>名称</label>
        <input defaultValue={`新的${kind}`} />
      </div>
      <div className="field">
        <label>描述</label>
        <textarea placeholder={`说明这个${kind}的用途、边界和使用方式`} />
      </div>
      <div className="field">
        <label>可见范围</label>
        <select defaultValue="org">
          <option value="org">当前组织</option>
          <option value="private">仅自己</option>
          <option value="public">公开</option>
        </select>
      </div>
    </>
  );
}
