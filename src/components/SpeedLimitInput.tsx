import { useEffect, useState } from "react";
import {
  speedFromKmh,
  speedToKmh,
  speedUnitLabel,
  type SpeedUnit,
} from "../units";
export default function SpeedLimitInput({
  valueKmh,
  unit,
  onCommit,
  id = "speed-limit",
  disabled = false,
  onValidityChange,
}: {
  valueKmh: number;
  unit: SpeedUnit;
  onCommit: (kmh: number) => void;
  id?: string;
  disabled?: boolean;
  onValidityChange?: (valid: boolean) => void;
}) {
  const [draft, setDraft] = useState(() =>
    String(Number(speedFromKmh(valueKmh, unit).toFixed(2))),
  );
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDraft(String(Number(speedFromKmh(valueKmh, unit).toFixed(2))));
    setError("");
    setDirty(false);
    onValidityChange?.(true);
  }, [valueKmh, unit, onValidityChange]);
  const commit = () => {
    if (!dirty || disabled) return;
    const display = Number(draft),
      canonical = speedToKmh(display, unit);
    if (
      !draft.trim() ||
      !Number.isFinite(canonical) ||
      canonical < 5 ||
      canonical > 200
    ) {
      setError(
        `Enter a limit between ${Math.ceil(speedFromKmh(5, unit) * 1000) / 1000} and ${Math.floor(speedFromKmh(200, unit) * 1000) / 1000} ${speedUnitLabel(unit)}.`,
      );
      return;
    }
    setError("");
    setDirty(false);
    onCommit(canonical);
  };
  return (
    <>
      <div className="speed-input">
        <input
          id={id}
          disabled={disabled}
          type="number"
          step="any"
          value={draft}
          onChange={(event) => {
            const next = event.target.value;
            const canonical = speedToKmh(Number(next), unit);
            setDraft(next);
            setError("");
            setDirty(true);
            onValidityChange?.(
              !!next.trim() &&
                Number.isFinite(canonical) &&
                canonical >= 5 &&
                canonical <= 200,
            );
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <span>{speedUnitLabel(unit)}</span>
      </div>
      {error && (
        <p id={`${id}-error`} className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
