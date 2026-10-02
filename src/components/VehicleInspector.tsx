import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Download, Info, LoaderCircle, ScanSearch } from "lucide-react";
import Modal from "./Modal";
import PlateReader from "../ocr/PlateReader";
import { objectHudColor } from "../hud";
import { formatSpeed, type SpeedUnit } from "../units";
import {
  serializeVehicleInspection,
  vehicleInspectionCropBounds,
  type ObservationPlateCandidate,
  type VehicleInspection,
} from "../vision/vehicleInspection";
import "./vehicle-inspector.css";
export interface VehicleInspectorProps {
  inspection: VehicleInspection;
  speedUnit: SpeedUnit;
  onClose: () => void;
}
function download(content: string, name: string, type?: string) {
  const url = type
    ? URL.createObjectURL(new Blob([content], { type }))
    : content;
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  if (type) setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function VehicleInspector(props: VehicleInspectorProps) {
  const { inspection } = props;
  return (
    <VehicleInspectorBody
      key={JSON.stringify([
        inspection.sourceKind,
        inspection.sourceId,
        inspection.frameId,
        inspection.track.id,
        inspection.sourceTimestamp,
        inspection.captureTime,
      ])}
      {...props}
    />
  );
}
function VehicleInspectorBody({
  inspection,
  speedUnit,
  onClose,
}: VehicleInspectorProps) {
  const [crop, setCrop] = useState<{
    url: string;
    width: number;
    height: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [candidate, setCandidate] = useState<ObservationPlateCandidate | null>(
    null,
  );
  const currentInspection = useRef<VehicleInspection | null>(inspection);
  const track = inspection.track;
  const demo = inspection.sourceKind === "demo";
  const [x, y, width, height] = track.bbox;
  const fileBase = `traffic-control-observation-frame-${inspection.frameId}-track-${track.id}`;
  useEffect(() => {
    currentInspection.current = inspection;
    let current = true;
    setCrop(null);
    setCandidate(null);
    setError("");
    const image = new Image();
    image.onload = () => {
      if (!current) return;
      try {
        const bounds = vehicleInspectionCropBounds(
          inspection,
          image.naturalWidth,
          image.naturalHeight,
        );
        const canvas = document.createElement("canvas");
        canvas.width = bounds[2];
        canvas.height = bounds[3];
        const context = canvas.getContext("2d");
        if (!context)
          throw new Error(
            "This browser could not prepare the selected vehicle crop.",
          );
        context.imageSmoothingEnabled = false;
        context.drawImage(image, ...bounds, 0, 0, bounds[2], bounds[3]);
        const url = canvas.toDataURL("image/png");
        if (current) setCrop({ url, width: bounds[2], height: bounds[3] });
      } catch (cause) {
        if (current)
          setError(
            cause instanceof Error
              ? cause.message
              : "This vehicle frame could not be inspected.",
          );
      }
    };
    image.onerror = () => {
      if (current)
        setError(
          "The frozen frame is no longer available. Close this observation and select a fresh frame.",
        );
    };
    image.src = inspection.imageUrl;
    return () => {
      current = false;
      currentInspection.current = null;
      image.onload = null;
      image.onerror = null;
    };
  }, [inspection]);
  return (
    <Modal
      title={`${track.className.charAt(0).toUpperCase()}${track.className.slice(1)} · Track #${track.id}`}
      subtitle={
        demo
          ? "Simulated vehicle observation · no ticket created"
          : "Vehicle observation · no ticket created"
      }
      onClose={onClose}
      wide
    >
      <div className="vehicle-inspector">
        <section
          className="vehicle-inspection-context"
          aria-label="Frozen observation context"
        >
          {crop ? (
            <figure className="vehicle-inspection-frame">
              <img
                src={inspection.imageUrl}
                alt="Frozen source frame with the selected vehicle outlined"
              />
              <span
                className="vehicle-inspection-box"
                style={{
                  left: `${(x / inspection.frameWidth) * 100}%`,
                  top: `${(y / inspection.frameHeight) * 100}%`,
                  width: `${(width / inspection.frameWidth) * 100}%`,
                  height: `${(height / inspection.frameHeight) * 100}%`,
                  borderColor: objectHudColor(track.className),
                }}
              />
              <figcaption>
                FROZEN FRAME {inspection.frameId} · TRACK #{track.id}
              </figcaption>
            </figure>
          ) : error ? (
            <p className="vehicle-inspection-error" role="alert">
              {error}
            </p>
          ) : (
            <div className="vehicle-inspection-loading" role="status">
              <LoaderCircle size={18} /> Preparing original pixels…
            </div>
          )}
          <dl className="vehicle-inspection-details">
            <div>
              <dt>Object class</dt>
              <dd>{track.className}</dd>
            </div>
            <div>
              <dt>Detection model score</dt>
              <dd>{(track.score * 100).toFixed(1)}%</dd>
            </div>
            <div>
              <dt>
                {demo ? "Simulated speed" : "Recent-window speed estimate"}
              </dt>
              <dd>
                {track.speedKmh === null
                  ? "Unavailable"
                  : formatSpeed(track.speedKmh, speedUnit)}
              </dd>
            </div>
            <div>
              <dt>Local track ID</dt>
              <dd>
                #{track.id} · {track.age.toFixed(1)} s observed
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{inspection.sourceName}</dd>
            </div>
            <div>
              <dt>Media timestamp</dt>
              <dd>{inspection.sourceTimestamp.toFixed(3)} s</dd>
            </div>
            <div>
              <dt>Captured locally (UTC)</dt>
              <dd>{new Date(inspection.captureTime).toISOString()}</dd>
            </div>
            <div>
              <dt>Original frame</dt>
              <dd>
                {inspection.frameWidth} × {inspection.frameHeight} px
              </dd>
            </div>
          </dl>
          <div className="vehicle-inspection-note">
            <Info size={16} />
            <p>
              {demo
                ? "This procedural scene and its measurements are simulated. Registration reading is unavailable for demo vehicles."
                : "This snapshot stays fixed when new frames arrive. Local capture time may follow a delayed stream. Class scores and track IDs do not establish a vehicle's make, model, registration or keeper."}
            </p>
          </div>
          <div className="vehicle-inspection-downloads">
            <button
              className="button secondary"
              type="button"
              disabled={!crop}
              onClick={() =>
                download(
                  serializeVehicleInspection(inspection, candidate),
                  `${fileBase}.json`,
                  "application/json",
                )
              }
            >
              <Download size={14} /> Observation JSON
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={!crop}
              onClick={() => crop && download(crop.url, `${fileBase}-crop.png`)}
            >
              <Download size={14} /> Vehicle crop
            </button>
          </div>
        </section>
        <section
          className="vehicle-inspection-reader"
          aria-label="Selected vehicle registration"
          style={
            {
              "--vehicle-crop-surface-width": crop
                ? `${(260 * crop.width) / crop.height}px`
                : "100%",
            } as CSSProperties
          }
        >
          <div className="vehicle-inspection-reader-intro">
            <ScanSearch size={18} />
            <div>
              <h3>Selected vehicle only</h3>
              <p>
                {crop ? `${crop.width} × ${crop.height} original pixels. ` : ""}
                The reader receives this vehicle crop; the surrounding frame is
                excluded. Enlarged previews add no image detail.
              </p>
            </div>
          </div>
          {demo ? (
            <p className="vehicle-inspection-unavailable">
              Simulated scene · OCR disabled
            </p>
          ) : track.className === "person" ? (
            <p className="vehicle-inspection-unavailable">
              Registration reading applies to vehicles.
            </p>
          ) : crop ? (
            <PlateReader
              imageUrl={crop.url}
              vehicleBox={[0, 0, crop.width, crop.height]}
              context="observation"
              onCandidateReset={() => {
                if (currentInspection.current === inspection)
                  setCandidate(null);
              }}
              onRead={(text, originalOcrScore) => {
                if (currentInspection.current === inspection)
                  setCandidate({ text, originalOcrScore });
              }}
            />
          ) : (
            <p className="vehicle-inspection-unavailable">
              Registration reading waits for a matching frozen image.
            </p>
          )}
          {candidate && (
            <div className="vehicle-inspection-candidate" role="status">
              <span>Unverified observation candidate</span>
              <strong>{candidate.text}</strong>
              <p>
                Retained only in this open observation and its optional JSON
                download. No case has been created.
              </p>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
