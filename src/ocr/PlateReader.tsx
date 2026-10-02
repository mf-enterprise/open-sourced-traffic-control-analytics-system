import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Check, Crop, LoaderCircle, ScanText, RotateCcw } from "lucide-react";
import { isPlateCandidate, normalizePlateText } from "./plateText";
import {
  preparePlateCrop,
  nativePlateCrop,
  readPlate,
  releasePlateReader,
  type NormalizedCrop,
  type OcrProgress,
} from "./readPlate";
import "./plate-reader.css";
import {
  clipVehicleBox,
  hasAutomaticReadDetail,
  mapPlateSuggestions,
  type PixelBox,
  type PlateSuggestion,
} from "./plateCandidates";
export interface PlateReaderProps {
  imageUrl: string;
  vehicleBox?: PixelBox | null;
  onRead: (plate: string, confidence: number) => void;
  context?: "case" | "observation";
  onCandidateReset?: () => void;
}
const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));
export default function PlateReader(props: PlateReaderProps) {
  return (
    <PlateReaderBody
      key={`${props.imageUrl}|${props.vehicleBox?.join(",") ?? ""}`}
      {...props}
    />
  );
}
function PlateReaderBody({
  imageUrl,
  vehicleBox,
  onRead,
  context = "case",
  onCandidateReset,
}: PlateReaderProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const start = useRef<{
    x: number;
    y: number;
  } | null>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const autoAttempted = useRef(false);
  const plateEngine = useRef<typeof import("./plateDetector") | null>(null);
  const [crop, setCrop] = useState<NormalizedCrop | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [candidate, setCandidate] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [used, setUsed] = useState(false);
  const [suggestions, setSuggestions] = useState<PlateSuggestion[]>([]);
  const [notice, setNotice] = useState("");
  const [recognizer, setRecognizer] = useState("");
  const inputId = useId();
  const instructionsId = useId();
  const boundsKey = vehicleBox?.join(",") ?? "";
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
      plateEngine.current?.releasePlateDetector();
      plateEngine.current = null;
      releasePlateReader();
    };
  }, []);
  useEffect(() => {
    request.current++;
    setCrop(null);
    setLoaded(
      Boolean(imageRef.current?.complete && imageRef.current.naturalWidth),
    );
    setBusy(false);
    setProgress(null);
    setCandidate("");
    setConfidence(null);
    setError("");
    setUsed(false);
    setSuggestions([]);
    setNotice("");
    setRecognizer("");
    autoAttempted.current = false;
    start.current = null;
  }, [imageUrl, boundsKey]);
  useEffect(() => {
    if (
      loaded &&
      vehicleBox &&
      !autoAttempted.current &&
      imageRef.current?.complete
    ) {
      autoAttempted.current = true;
      void locatePlate();
    }
  }, [loaded, imageUrl, boundsKey]);
  useEffect(() => {
    const canvas = previewRef.current,
      image = imageRef.current;
    if (!canvas || !image || !loaded || !crop) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const sourceWidth = crop.width * image.naturalWidth;
    const sourceHeight = crop.height * image.naturalHeight;
    canvas.width = Math.min(720, Math.max(120, Math.round(sourceWidth * 4)));
    canvas.height = Math.min(
      180,
      Math.max(28, Math.round((canvas.width * sourceHeight) / sourceWidth)),
    );
    context.fillStyle = "#11191b";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(
      canvas.width / sourceWidth,
      canvas.height / sourceHeight,
    );
    const width = sourceWidth * scale,
      height = sourceHeight * scale;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      image,
      crop.x * image.naturalWidth,
      crop.y * image.naturalHeight,
      sourceWidth,
      sourceHeight,
      (canvas.width - width) / 2,
      (canvas.height - height) / 2,
      width,
      height,
    );
  }, [crop, loaded]);
  function clearCandidate() {
    onCandidateReset?.();
    setCandidate("");
    setConfidence(null);
    setUsed(false);
    setError("");
    setNotice("");
  }
  function pointerPosition(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height),
    };
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!loaded || busy || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = pointerPosition(event);
    clearCandidate();
    setCrop({ ...start.current, width: 0.001, height: 0.001 });
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!start.current || busy) return;
    const end = pointerPosition(event);
    setCrop({
      x: Math.min(start.current.x, end.x),
      y: Math.min(start.current.y, end.y),
      width: Math.max(0.001, Math.abs(end.x - start.current.x)),
      height: Math.max(0.001, Math.abs(end.y - start.current.y)),
    });
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    pointerMove(event);
    start.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function centerCrop() {
    if (busy || !loaded) return;
    clearCandidate();
    setCrop({ x: 0.36, y: 0.43, width: 0.28, height: 0.14 });
    surfaceRef.current?.focus();
  }
  function keyboardCrop(event: KeyboardEvent<HTMLDivElement>) {
    if (busy || !loaded) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      centerCrop();
      return;
    }
    if (
      !crop ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    clearCandidate();
    const step = event.altKey ? 0.001 : 0.008;
    const dx =
      event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    const dy =
      event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
    setCrop(
      event.shiftKey
        ? {
            ...crop,
            width: clamp(crop.width + dx, 0.01, 1 - crop.x),
            height: clamp(crop.height + dy, 0.01, 1 - crop.y),
          }
        : {
            ...crop,
            x: clamp(crop.x + dx, 0, 1 - crop.width),
            y: clamp(crop.y + dy, 0, 1 - crop.height),
          },
    );
  }
  async function readSelection(
    image: HTMLImageElement,
    selection: NormalizedCrop,
    token: number,
    automatic = false,
    compatibility = false,
  ) {
    let result: {
      plate: string;
      confidence: number;
      unsupportedScript?: boolean;
    };
    if (compatibility) {
      setRecognizer("Tesseract compatibility OCR");
      const canvas = preparePlateCrop(image, selection);
      result = await readPlate(canvas, (update) => {
        if (mounted.current && request.current === token) setProgress(update);
      });
    } else {
      setRecognizer("PaddleOCR · local recognition");
      const canvas = nativePlateCrop(image, selection);
      const engine = await import("./plateDetector");
      if (!mounted.current || request.current !== token) return;
      plateEngine.current = engine;
      result = await engine.recognizePlate(canvas, (status) => {
        if (mounted.current && request.current === token)
          setProgress({ status, progress: 0 });
      });
    }
    if (!mounted.current || request.current !== token) return;
    if (result.unsupportedScript) {
      setError(
        "This plate uses an unsupported alphabet. This build reads Latin letters and digits; no registration was suggested.",
      );
      return;
    }
    if (automatic && result.confidence < 75) {
      setError(
        "A possible plate was located, but its text is too uncertain to suggest automatically. Inspect the crop or enter the registration manually.",
      );
      return;
    }
    setConfidence(result.confidence);
    if (isPlateCandidate(result.plate)) setCandidate(result.plate);
    else
      setError(
        "No usable registration was read. Tighten the crop or use a clearer frame, then try again.",
      );
  }
  async function locatePlate() {
    const image = imageRef.current;
    if (!image || !image.complete || !image.naturalWidth || busy) return;
    const bounds = clipVehicleBox(
      vehicleBox,
      image.naturalWidth,
      image.naturalHeight,
    );
    if (!bounds) {
      setError(
        context === "observation"
          ? "This observation has no usable vehicle bounds. Select a fresh vehicle frame."
          : "This case has no recorded vehicle bounds. Select the plate manually to avoid reading another vehicle's registration.",
      );
      return;
    }
    const token = ++request.current;
    setBusy(true);
    clearCandidate();
    setSuggestions([]);
    setCrop(null);
    setProgress({ status: "Locating the vehicle's plate", progress: 0 });
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bounds[2];
      canvas.height = bounds[3];
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("This browser could not read the evidence image.");
      context.drawImage(image, ...bounds, 0, 0, bounds[2], bounds[3]);
      const engine = await import("./plateDetector");
      if (!mounted.current || request.current !== token) return;
      plateEngine.current = engine;
      await engine.loadPlateDetector((status) => {
        if (mounted.current && request.current === token)
          setProgress({ status, progress: 0 });
      });
      if (!mounted.current || request.current !== token) return;
      const found = await engine.detectPlates(canvas);
      if (!mounted.current || request.current !== token) return;
      const mapped = mapPlateSuggestions(
        found,
        bounds,
        image.naturalWidth,
        image.naturalHeight,
      );
      setSuggestions(mapped);
      if (!mapped.length) {
        setError(
          "No plate was located in this vehicle's evidence crop. Use a closer, clearer frame or select a visible plate manually.",
        );
      } else if (mapped.length > 1) {
        setNotice(
          "Several possible plates were found. Select the one belonging to this vehicle before reading it.",
        );
      } else {
        setCrop(mapped[0].crop);
        if (!hasAutomaticReadDetail(mapped[0])) {
          setError(
            "A possible plate was located, but it has too few original pixels for automatic reading. A closer camera view is needed.",
          );
        } else {
          setNotice(
            "Plate located in the captured vehicle. Any suggested characters still need verification against the image.",
          );
          await readSelection(image, mapped[0].crop, token, true);
        }
      }
    } catch (cause) {
      if (mounted.current && request.current === token)
        setError(
          cause instanceof Error
            ? cause.message
            : "Automatic plate search could not finish. You can still select a plate manually.",
        );
    } finally {
      if (mounted.current && request.current === token) {
        setBusy(false);
        setProgress(null);
      }
    }
  }
  async function recognize(compatibility = false) {
    const image = imageRef.current;
    if (!image || !crop || busy || !loaded) return;
    const token = ++request.current;
    setBusy(true);
    clearCandidate();
    setProgress({ status: "Preparing crop", progress: 0 });
    try {
      await readSelection(image, crop, token, false, compatibility);
    } catch {
      if (mounted.current && request.current === token)
        setError(
          "Recognition could not finish. Retry the read or use compatibility OCR with a manually selected crop.",
        );
    } finally {
      if (mounted.current && request.current === token) {
        setBusy(false);
        setProgress(null);
      }
    }
  }
  const imageWidth = imageRef.current?.naturalWidth || 0;
  const imageHeight = imageRef.current?.naturalHeight || 0;
  const cropWidth = crop ? Math.round(crop.width * imageWidth) : 0;
  const cropHeight = crop ? Math.round(crop.height * imageHeight) : 0;
  const normalized = normalizePlateText(candidate);
  const valid = isPlateCandidate(normalized);
  const progressLabel = progress?.status.includes("recognizing")
    ? "Reading selected registration"
    : progress?.status.includes("loading") ||
        progress?.status.includes("initializing")
      ? "Preparing OCR model"
      : progress?.status || "Preparing recognition";
  return (
    <section
      className="plate-reader"
      aria-label="Assisted registration reading"
    >
      <div className="plate-reader-heading">
        <ScanText size={17} />
        <div>
          <strong>
            {context === "observation"
              ? "Read registration from vehicle crop"
              : "Read registration from evidence"}
          </strong>
          <span>Locate the plate, then verify the suggested text.</span>
        </div>
        <span className="plate-reader-badge">ASSISTED OCR</span>
      </div>
      <p id={instructionsId} className="plate-reader-instructions">
        Drag a box tightly around one line of registration text. Keep all
        characters inside the crop.
      </p>
      <div
        className={`plate-crop-surface${busy ? " is-busy" : ""}`}
        ref={surfaceRef}
        tabIndex={loaded && !busy ? 0 : -1}
        role="group"
        aria-label="Registration crop selector"
        aria-describedby={instructionsId}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={() => {
          start.current = null;
        }}
        onKeyDown={keyboardCrop}
      >
        <img
          ref={imageRef}
          src={imageUrl}
          alt={
            context === "observation"
              ? "Original selected vehicle crop. Select the visible registration plate."
              : "Original incident evidence. Select the visible registration plate."
          }
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setError("The evidence image could not be loaded.");
          }}
        />
        {crop && (
          <div
            className="plate-crop-selection"
            style={{
              left: `${crop.x * 100}%`,
              top: `${crop.y * 100}%`,
              width: `${crop.width * 100}%`,
              height: `${crop.height * 100}%`,
            }}
          >
            <i />
            <i />
            <i />
            <i />
          </div>
        )}
        {!crop && loaded && (
          <span className="plate-crop-hint">
            <Crop size={17} /> Draw a crop around the plate
          </span>
        )}
      </div>
      <div className="plate-crop-tools">
        <button
          type="button"
          onClick={() => void recognize(true)}
          disabled={busy || !loaded || !crop}
        >
          Try compatibility OCR
        </button>
        <button
          type="button"
          onClick={() => void locatePlate()}
          disabled={busy || !loaded || !vehicleBox}
        >
          <ScanText size={12} /> Find and read plate
        </button>
        <button type="button" onClick={centerCrop} disabled={busy || !loaded}>
          <Crop size={12} /> Select center crop
        </button>
        <button
          type="button"
          onClick={() => {
            setCrop(null);
            clearCandidate();
          }}
          disabled={busy || !crop}
        >
          <RotateCcw size={12} /> Reset
        </button>
        {crop && (
          <span>
            {cropWidth} × {cropHeight} source pixels
          </span>
        )}
      </div>
      {busy && (
        <button
          type="button"
          className="plate-cancel"
          onClick={() => {
            request.current++;
            plateEngine.current?.releasePlateDetector();
            plateEngine.current = null;
            releasePlateReader();
            setBusy(false);
            setProgress(null);
            setNotice(
              "Automatic analysis stopped. Select a plate manually or try again.",
            );
          }}
        >
          Cancel analysis
        </button>
      )}
      {suggestions.length > 1 && (
        <div
          className="plate-suggestions"
          aria-label="Possible plate locations"
        >
          {suggestions.map((suggestion, index) => (
            <button
              type="button"
              key={index}
              disabled={busy}
              onClick={() => {
                clearCandidate();
                setCrop(suggestion.crop);
              }}
            >
              Possible plate {index + 1} · {suggestion.sourceWidth} ×{" "}
              {suggestion.sourceHeight} px
            </button>
          ))}
        </div>
      )}
      {notice && (
        <p className="plate-reader-notice" role="status">
          {notice}
        </p>
      )}
      {recognizer && <p className="plate-keyboard-help">{recognizer}</p>}
      <p className="plate-keyboard-help">
        Keyboard: select a center crop, use arrow keys to move and Shift +
        arrows to resize. Alt makes fine adjustments.
      </p>
      {crop && (
        <div className="plate-crop-preview">
          <span>SELECTED DETAIL</span>
          <canvas
            ref={previewRef}
            aria-label="Enlarged preview of the selected registration crop"
          />
        </div>
      )}
      {crop && (cropWidth < 80 || cropHeight < 18) && (
        <p className="plate-reader-warning">
          This crop contains very few source pixels. A closer or
          higher-resolution frame may be needed for a reliable read.
        </p>
      )}
      <div className="plate-reader-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy || !loaded || !crop || cropWidth < 5 || cropHeight < 3}
          onClick={() => void recognize()}
        >
          {busy ? (
            <LoaderCircle size={14} className="plate-spinner" />
          ) : (
            <ScanText size={14} />
          )}
          {busy ? "Reading registration…" : "Read registration"}
        </button>
        {busy && (
          <span role="status">
            {progressLabel}
            {progress && progress.progress > 0
              ? ` · ${Math.round(progress.progress * 100)}%`
              : ""}
          </span>
        )}
      </div>
      {busy && (
        <div
          className="plate-reader-progress"
          role="progressbar"
          aria-label="OCR progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((progress?.progress || 0) * 100)}
        >
          <span
            style={{
              width: `${Math.max(5, (progress?.progress || 0) * 100)}%`,
            }}
          />
        </div>
      )}
      {error && (
        <p className="plate-reader-error" role="alert">
          {error}
        </p>
      )}
      {confidence !== null && (
        <div className="plate-candidate-panel">
          <div className="plate-candidate-label">
            <label htmlFor={inputId}>Unverified candidate</label>
            <span>Original OCR score: {confidence.toFixed(1)}/100</span>
          </div>
          <div className="plate-candidate-entry">
            <input
              id={inputId}
              aria-label="Unverified registration candidate"
              value={candidate}
              maxLength={18}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                onCandidateReset?.();
                setCandidate(event.target.value.toUpperCase());
                setUsed(false);
              }}
            />
            <button
              type="button"
              className="button primary"
              disabled={!valid || used}
              onClick={() => {
                onRead(normalized, confidence);
                setUsed(true);
              }}
            >
              <Check size={14} />
              {context === "observation"
                ? used
                  ? "Candidate retained"
                  : "Keep candidate"
                : used
                  ? "Candidate added"
                  : "Use candidate"}
            </button>
          </div>
          <p>
            Check every character against the image and correct the text here.
            OCR confidence is not proof of identity; using this candidate does
            not verify the registration.
          </p>
        </div>
      )}
      <p className="plate-reader-privacy">
        Recognition runs in this browser. Plate detection and primary OCR use
        local model files. Compatibility OCR may download its model on first
        use. Evidence images are not uploaded.
      </p>
    </section>
  );
}
