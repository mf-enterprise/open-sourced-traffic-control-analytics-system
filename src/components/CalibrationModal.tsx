import { useRef, useState } from "react";
import { Check, Crosshair } from "lucide-react";
import type { Calibration, Point } from "../vision/types";
import Modal from "./Modal";
export default function CalibrationModal({
  canvas,
  current,
  demo,
  onClose,
  onSave,
  saving = false,
  errorMessage,
  onClear,
}: {
  canvas: HTMLCanvasElement | null;
  current: Calibration | null;
  demo: boolean;
  onClose: () => void;
  onSave: (value: Calibration) => void;
  saving?: boolean;
  errorMessage?: string;
  onClear?: () => void;
}) {
  const [snapshot] = useState(() => canvas?.toDataURL("image/jpeg", 0.9) || "");
  const [points, setPoints] = useState<Point[]>(
    current?.points || [
      { x: 0.36, y: 0.27 },
      { x: 0.67, y: 0.27 },
      { x: 0.84, y: 0.86 },
      { x: 0.16, y: 0.86 },
    ],
  );
  const [width, setWidth] = useState(
      current ? String(current.widthMeters) : demo ? "10" : "",
    ),
    [length, setLength] = useState(
      current ? String(current.lengthMeters) : demo ? "30" : "",
    ),
    [error, setError] = useState("");
  const drag = useRef<number | null>(null),
    surface = useRef<HTMLDivElement>(null);
  const validate = () => {
    if (saving) return;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = points[i],
        b = points[(i + 1) % 4],
        c = points[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 0.002 || (sign && Math.sign(cross) !== sign)) {
        setError(
          "Use four distinct corners around a convex road rectangle. Avoid crossed edges.",
        );
        return;
      }
      sign = Math.sign(cross);
    }
    const measuredWidth = Number(width),
      measuredLength = Number(length);
    if (
      !width.trim() ||
      !length.trim() ||
      !Number.isFinite(measuredWidth) ||
      !Number.isFinite(measuredLength) ||
      measuredWidth < 1 ||
      measuredLength < 1 ||
      measuredWidth > 1000 ||
      measuredLength > 1000
    ) {
      setError(
        "Enter both real measured dimensions between 1 and 1,000 metres. The camera image cannot supply an absolute road scale.",
      );
      return;
    }
    onSave({
      points: points as Calibration["points"],
      widthMeters: measuredWidth,
      lengthMeters: measuredLength,
    });
  };
  return (
    <Modal
      title="Calibrate the road plane."
      subtitle="Drag the four points to the corners of a measured rectangle on the road."
      onClose={onClose}
      wide
    >
      <div className="calibration-layout">
        <div
          className="calibration-surface"
          style={{
            aspectRatio: canvas ? `${canvas.width}/${canvas.height}` : "16/9",
          }}
          ref={surface}
          onPointerMove={(e) => {
            if (drag.current === null || !surface.current) return;
            const rect = surface.current.getBoundingClientRect();
            const p = {
              x: Math.max(
                0.01,
                Math.min(0.99, (e.clientX - rect.left) / rect.width),
              ),
              y: Math.max(
                0.01,
                Math.min(0.99, (e.clientY - rect.top) / rect.height),
              ),
            };
            setPoints((prev) =>
              prev.map((old, i) => (i === drag.current ? p : old)),
            );
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <img
            src={snapshot}
            alt="Road calibration reference frame"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              minHeight: 0,
              maxHeight: "none",
              objectFit: "fill",
              display: "block",
            }}
          />
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <polygon
              points={points.map((p) => `${p.x * 100},${p.y * 100}`).join(" ")}
              fill="#d4f29619"
              stroke="#d4f296"
              strokeWidth=".35"
              strokeDasharray="1.2 .6"
            />
          </svg>
          {points.map((p, i) => (
            <button
              key={i}
              className="calibration-handle"
              aria-label={`Calibration corner ${i + 1}`}
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
              onPointerDown={(e) => {
                drag.current = i;
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onKeyDown={(e) => {
                const delta = 0.005;
                const moves: Record<string, [number, number]> = {
                  ArrowLeft: [-delta, 0],
                  ArrowRight: [delta, 0],
                  ArrowUp: [0, -delta],
                  ArrowDown: [0, delta],
                };
                if (moves[e.key]) {
                  e.preventDefault();
                  const [dx, dy] = moves[e.key];
                  setPoints((prev) =>
                    prev.map((p, j) =>
                      j === i
                        ? {
                            x: Math.max(0.01, Math.min(0.99, p.x + dx)),
                            y: Math.max(0.01, Math.min(0.99, p.y + dy)),
                          }
                        : p,
                    ),
                  );
                }
              }}
            >
              {i + 1}
            </button>
          ))}
        </div>
        <div className="calibration-form">
          <div className="step-label">01 / ROAD GEOMETRY</div>
          <p>
            Use a flat rectangle whose real dimensions you have measured or
            obtained from surveyed plans. Place all four corners in perimeter
            order: 1–2 is its width, 2–3 its length.
          </p>
          <label>
            Road width (1 → 2)
            <div className="unit-input">
              <input
                type="number"
                aria-label="Road width in metres"
                min="1"
                max="1000"
                value={width}
                placeholder="Measured width"
                onChange={(e) => setWidth(e.target.value)}
              />
              <span>m</span>
            </div>
          </label>
          <label>
            Road length (2 → 3)
            <div className="unit-input">
              <input
                type="number"
                aria-label="Road length in metres"
                min="1"
                max="1000"
                value={length}
                placeholder="Measured length"
                onChange={(e) => setLength(e.target.value)}
              />
              <span>m</span>
            </div>
          </label>
          <div className="info-box">
            <Crosshair size={18} />
            <span>
              A camera image contains no absolute distance scale. Enter measured
              distances, not guessed lane widths. Keep the camera fixed. Vehicle
              ground-contact points must stay inside this rectangle for enough
              samples before a speed estimate is available.
            </span>
          </div>
          {demo && (
            <p className="subtle-note">
              Demo speeds are simulated; this calibration is for practicing the
              workflow.
            </p>
          )}
          {(error || errorMessage) && (
            <p className="form-error" role="alert">
              {error || errorMessage}
            </p>
          )}
          <button
            className="button primary full-width"
            onClick={validate}
            disabled={saving}
          >
            <Check size={16} />
            {saving ? "Saving calibration…" : "Save calibration"}
          </button>
          {current && onClear && (
            <button
              className="button secondary full-width"
              onClick={onClear}
              disabled={saving}
            >
              Clear road scale
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
