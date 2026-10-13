import { CalendarIcon } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { Calendar } from "./calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

interface DatePickerProps {
  value?: Date;
  onChange?: (date: Date | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** 日期格式化使用的 BCP 47 区域标签；省略时沿用运行环境的默认区域设置。 */
  locale?: string;
}

function DatePicker({ value, onChange, placeholder, disabled, className, locale }: DatePickerProps) {
  // 英文默认文案，调用方可通过 placeholder 覆盖；本包不自带 i18n 单例，不读取宿主文案。
  const ph = placeholder ?? "Select date";
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className={cn("w-full justify-start text-left font-normal", !value && "text-muted-foreground", className)}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {value ? value.toLocaleDateString(locale) : ph}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={(date) => {
            onChange?.(date);
            setOpen(false);
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}

export type { DatePickerProps };
export { DatePicker };
