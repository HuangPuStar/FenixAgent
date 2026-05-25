import { Button } from "../ui/button";
import { Card } from "../ui/card";

interface BatchActionBarProps {
  selectedCount: number;
  actions: Array<{
    label: string;
    icon?: React.ReactNode;
    variant?: "default" | "destructive";
    onClick: () => void;
  }>;
  onClear: () => void;
}

export function BatchActionBar({ selectedCount, actions, onClear }: BatchActionBarProps) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
      <Card className="flex flex-row items-center gap-3 px-4 py-2 shadow-lg">
        <span className="text-sm font-medium">已选择 {selectedCount} 项</span>
        {actions.map((action) => (
          <Button key={action.label} size="sm" variant={action.variant || "default"} onClick={action.onClick}>
            {action.icon}
            {action.label}
          </Button>
        ))}
        <Button size="sm" variant="outline" onClick={onClear}>
          清除
        </Button>
      </Card>
    </div>
  );
}
