import {
  type ButtonHTMLAttributes,
  cloneElement,
  createContext,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
} from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "ghost" | "outline";
  size?: "xs" | "sm" | "icon-xs" | "icon-sm";
};

export function Button({ variant = "default", size, className = "", ...props }: ButtonProps) {
  return <button className={`demo-ui-button is-${variant}${size ? ` is-${size}` : ""} ${className}`} {...props} />;
}

export function TooltipProvider({ children }: { children: ReactNode; delayDuration?: number }) {
  return children;
}

export function Tooltip({ children }: { children: ReactNode }) {
  return <span className="demo-ui-tooltip">{children}</span>;
}

export function TooltipTrigger({ children, asChild }: { children: ReactElement; asChild?: boolean }) {
  return asChild ? cloneElement(children) : <span>{children}</span>;
}

export function TooltipContent({ children }: { children: ReactNode }) {
  return <span className="demo-ui-tooltip__content">{children}</span>;
}

interface OpenContextValue {
  open: boolean;
  close: () => void;
}

const DialogContext = createContext<OpenContextValue>({ open: false, close: () => undefined });

export function Dialog({
  children,
  open,
  onOpenChange,
}: {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return <DialogContext.Provider value={{ open, close: () => onOpenChange(false) }}>{children}</DialogContext.Provider>;
}

export function DialogContent({ children, className = "" }: HTMLAttributes<HTMLDivElement>) {
  const dialog = useContext(DialogContext);
  useEscapeClose(dialog.open, dialog.close);
  if (!dialog.open) return null;
  return (
    <div
      className="demo-ui-overlay"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && dialog.close()}
    >
      <section className={`demo-ui-dialog ${className}`} role="dialog" aria-modal="true">
        {children}
      </section>
    </div>
  );
}

export function DialogHeader({ children }: { children: ReactNode }) {
  return <header className="demo-ui-dialog__header">{children}</header>;
}

export function DialogTitle({ children }: { children: ReactNode }) {
  return <h2>{children}</h2>;
}

export function DialogDescription({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}

const AlertContext = createContext<OpenContextValue>({ open: false, close: () => undefined });

export function AlertDialog({
  children,
  open,
  onOpenChange,
}: {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return <AlertContext.Provider value={{ open, close: () => onOpenChange(false) }}>{children}</AlertContext.Provider>;
}

export function AlertDialogContent({ children, className = "" }: HTMLAttributes<HTMLDivElement> & { size?: string }) {
  const alert = useContext(AlertContext);
  useEscapeClose(alert.open, alert.close);
  if (!alert.open) return null;
  return (
    <div
      className="demo-ui-overlay"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && alert.close()}
    >
      <section className={`demo-ui-dialog demo-ui-alert ${className}`} role="alertdialog" aria-modal="true">
        {children}
      </section>
    </div>
  );
}

export const AlertDialogHeader = DialogHeader;
export const AlertDialogTitle = DialogTitle;
export const AlertDialogDescription = DialogDescription;

export function AlertDialogFooter({ children }: { children: ReactNode }) {
  return <footer className="demo-ui-dialog__footer">{children}</footer>;
}

export function AlertDialogCancel({ children }: { children: ReactNode }) {
  const alert = useContext(AlertContext);
  return (
    <Button variant="outline" onClick={alert.close}>
      {children}
    </Button>
  );
}

export function AlertDialogAction({ children, onClick, className }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const alert = useContext(AlertContext);
  return (
    <Button
      className={className}
      onClick={(event) => {
        onClick?.(event);
        alert.close();
      }}
    >
      {children}
    </Button>
  );
}

interface TabsValue {
  value: string;
  setValue: (value: string) => void;
}

const TabsContext = createContext<TabsValue>({ value: "", setValue: () => undefined });

export function Tabs({
  children,
  value,
  onValueChange,
  className = "",
}: {
  children: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}) {
  return (
    <TabsContext.Provider value={{ value, setValue: onValueChange }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="tablist" {...props}>
      {children}
    </div>
  );
}

export function TabsTrigger({ children, value }: { children: ReactNode; value: string }) {
  const tabs = useContext(TabsContext);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={tabs.value === value}
      data-state={tabs.value === value ? "active" : "inactive"}
      onClick={() => tabs.setValue(value)}
    >
      {children}
    </button>
  );
}

export function TabsContent({ children, value }: { children: ReactNode; value: string }) {
  const tabs = useContext(TabsContext);
  if (tabs.value !== value) return null;
  return (
    <div role="tabpanel" data-slot="tabs-content">
      {children}
    </div>
  );
}

function useEscapeClose(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open]);
}
