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
    <fieldset className="model-modality-field">
      <legend>{label}</legend>
      <div>
        {values.map((value) => (
          <button
            type="button"
            key={value}
            disabled={disabled}
            className={selected.includes(value) ? "is-selected" : ""}
            onClick={() => onToggle(value)}
          >
            {value}
            {selected.includes(value) && <Check />}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
