import { Check, ChevronDown, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useOrg } from "../contexts/OrgContext";

/** Sidebar 顶部组织切换器 */
export function OrgSwitcher() {
  const { org, orgs, switchOrg } = useOrg();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (!org) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={[
          "flex items-center gap-2.5 w-full px-3 py-2 rounded-[var(--radius)]",
          "text-[13px] font-medium text-text-secondary",
          "hover:bg-surface-hover hover:text-text-primary",
          "transition-all duration-150 cursor-pointer",
        ].join(" ")}
      >
        <Users className="w-[18px] h-[18px] flex-shrink-0" />
        <span className="max-w-[120px] truncate">{org.name}</span>
        <ChevronDown className="w-3.5 h-3.5 text-text-dim ml-auto" />
      </button>

      {open && (
        <div
          className={[
            "absolute bottom-full left-0 mb-1 min-w-[200px]",
            "bg-surface-1 border border-border-subtle rounded-lg shadow-lg",
            "py-1 z-50",
          ].join(" ")}
        >
          {orgs.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => {
                switchOrg(o.id);
                setOpen(false);
              }}
              className={[
                "flex items-center gap-2 w-full px-3 py-2 text-[13px] text-left",
                "hover:bg-surface-hover transition-colors",
                o.id === org.id ? "text-brand font-medium" : "text-text-secondary",
              ].join(" ")}
            >
              {o.id === org.id && <Check className="w-3.5 h-3.5" />}
              <span className={o.id !== org.id ? "ml-[20px]" : ""}>{o.name}</span>
              <span className="ml-auto text-[11px] text-text-dim">{o.role}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
