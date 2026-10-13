import { LabeledField } from "@fenix/ui-components/config/LabeledField";
import { Input } from "@fenix/ui-components/ui/input";
import { Check } from "lucide-react";

export function ModelNumberField({
  label,
  value,
  disabled,
  step = "1",
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  step?: string;
  onChange: (value: string) => void;
}) {
  return (
    <LabeledField label={label}>
      <Input
        type="number"
        min="0"
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </LabeledField>
  );
}

export function ModelModalityField({
  label,
  values,
  selected,
  disabled,
  onToggle,
}: {
  label: string;
  values: string[];
  selected: string[];
  disabled: boolean;
  onToggle: (value: string) => void;
}) {
  return (
    <fieldset className="model-modality-field min-w-0">
      <legend className="mb-1.5 text-xs font-semibold">{label}</legend>
      <div className="flex flex-wrap gap-1.25">
        {values.map((value) => (
          <button
            type="button"
            key={value}
            disabled={disabled}
            className={`flex min-h-7 items-center gap-1 rounded-5 border-0 py-0 px-2 text-3xs ${
              selected.includes(value) ? "is-selected bg-blue-50 text-blue-600" : "bg-slate-100 text-slate-500"
            }`}
            onClick={() => onToggle(value)}
          >
            {value}
            {selected.includes(value) && <Check className="w-2.75" />}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
