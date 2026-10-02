import { useRef, useState } from "react";
import { ArrowDownUp, Check, RotateCcw } from "lucide-react";
import type { CountingLine } from "../vision/counting";
export default function CountingLineEditor({
  canvas,
  current,
  onSave,
}: {
  canvas: HTMLCanvasElement | null;
  current: CountingLine | null;
  onSave: (line: CountingLine | null) => void;
}) {
  const [snapshot] = useState(() => canvas?.toDataURL("image/jpeg", 0.9) || "");
  const [line, setLine] = useState<CountingLine>(
    current || { a: { x: 0.2, y: 0.65 }, b: { x: 0.8, y: 0.65 } },
  );
  const [error, setError] = useState("");
  const drag = useRef<"a" | "b" | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const move = (key: "a" | "b", x: number, y: number) => {
    setLine((previous) => ({
      ...previous,
      [key]: { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) },
    }));
    setError("");
  };
  return (
    <div className="counting-editor">
      <p className="subtle-note">
        Drag A and B across one traffic lane or roadway. Only confirmed vehicles
        crossing this segment are counted. Parked vehicles stay out of the
        crossing count.
      </p>
      <div
        ref={surface}
        className="calibration-surface"
        style={{
          aspectRatio: canvas ? `${canvas.width}/${canvas.height}` : "16/9",
        }}
        onPointerMove={(event) => {
          if (!drag.current || !surface.current) return;
          const bounds = surface.current.getBoundingClientRect();
          move(
            drag.current,
            (event.clientX - bounds.left) / bounds.width,
            (event.clientY - bounds.top) / bounds.height,
          );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {snapshot && (
          <img src={snapshot} alt="Traffic counting reference frame" />
        )}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line
            x1={line.a.x * 100}
            y1={line.a.y * 100}
            x2={line.b.x * 100}
            y2={line.b.y * 100}
            stroke="#d1f79b"
            strokeWidth="0.5"
            strokeDasharray="2 1"
          />
        </svg>
        {(["a", "b"] as const).map((key) => (
          <button
            key={key}
            className="calibration-handle"
            aria-label={`Counting line endpoint ${key.toUpperCase()}`}
            style={{
              left: `${line[key].x * 100}%`,
              top: `${line[key].y * 100}%`,
            }}
            onPointerDown={(event) => {
              drag.current = key;
              event.currentTarget.setPointerCapture(event.pointerId);
              event.preventDefault();
            }}
            onKeyDown={(event) => {
              const moves: Record<string, [number, number]> = {
                ArrowLeft: [-1, 0],
                ArrowRight: [1, 0],
                ArrowUp: [0, -1],
                ArrowDown: [0, 1],
              };
              const delta = moves[event.key];
              if (!delta) return;
              event.preventDefault();
              const step = event.shiftKey ? 0.02 : 0.005;
              move(
                key,
                line[key].x + delta[0] * step,
                line[key].y + delta[1] * step,
              );
            }}
          >
            {key.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="info-box">
        <ArrowDownUp size={17} />
        <span>
          For A → B drawn left to right, forward crosses downward and reverse
          crosses upward. Each track is counted once. Arrow keys move a selected
          endpoint. Saving starts a new counting session.
        </span>
      </div>
      {error && (
        <p className="orange" role="alert">
          {error}
        </p>
      )}
      <div className="counting-actions">
        <button className="button secondary" onClick={() => onSave(null)}>
          <RotateCcw size={15} />
          Disable line
        </button>
        <button
          className="button primary"
          onClick={() => {
            if (Math.hypot(line.a.x - line.b.x, line.a.y - line.b.y) < 0.05) {
              setError(
                "Place the endpoints farther apart to span a road or lane.",
              );
              return;
            }
            onSave(line);
          }}
        >
          <Check size={16} />
          Save counting line
        </button>
      </div>
    </div>
  );
}
