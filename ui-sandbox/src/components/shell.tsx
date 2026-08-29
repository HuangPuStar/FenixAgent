import { Bell, ChevronDown, Command, Menu, PanelLeftClose, PanelLeftOpen, Search, Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { NAV_GROUPS, PAGE_TITLES, type PageId } from "../navigation";

interface ShellProps {
  page: PageId;
  onNavigate: (page: PageId) => void;
  children: ReactNode;
}

export function Shell({ page, onNavigate, children }: ShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className={`shell${collapsed ? " shell--collapsed" : ""}`}>
      <aside className={`sidebar${mobileOpen ? " sidebar--mobile-open" : ""}`}>
        <div className="brand">
          <span className="brand__mark">
            <Sparkles />
          </span>
          <span className="brand__copy">
            <strong>Fenix AOS</strong>
            <small>Agent 操作系统</small>
          </span>
        </div>
        <nav className="nav" aria-label="主导航">
          {NAV_GROUPS.map((group) => (
            <section className="nav__group" key={group.label}>
              <p className="nav__label">{group.label}</p>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`nav__item${page === item.id ? " is-active" : ""}`}
                    title={item.label}
                    onClick={() => {
                      onNavigate(item.id);
                      setMobileOpen(false);
                    }}
                  >
                    <Icon />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </section>
          ))}
        </nav>
        <button className="profile" type="button">
          <span className="profile__avatar">王</span>
          <span>
            <strong>Pu Wang</strong>
            <small>凤凰科技</small>
          </span>
          <ChevronDown />
        </button>
        <button className="sidebar__collapse" type="button" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </button>
      </aside>
      <div className="shell__main">
        {page !== "chat" && (
          <header className="topbar">
            <button className="icon-button topbar__menu" type="button" onClick={() => setMobileOpen(!mobileOpen)}>
              <Menu />
            </button>
            <h1>{PAGE_TITLES[page]}</h1>
            <div className="topbar__search">
              <Search />
              <input aria-label="全局搜索" placeholder="搜索资源、智能体或命令" />
              <kbd>
                <Command /> K
              </kbd>
            </div>
            <span className="sandbox-badge">UI SANDBOX</span>
            <button className="icon-button" type="button" aria-label="通知">
              <Bell />
            </button>
          </header>
        )}
        <main className={`page${page === "chat" ? " page--chat" : ""}`} key={page}>
          {children}
        </main>
      </div>
    </div>
  );
}
