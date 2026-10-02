import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ArrowUpRight, Camera, Network, RefreshCw, Usb } from "lucide-react";
import CameraConnector from "./CameraConnector";
import {
  listLocalCameras,
  type BackgroundCameraConfig,
  type LocalCameraInventory,
} from "./backgroundMonitorClient";
type ConnectorProps = {
  onConnect: (camera: BackgroundCameraConfig) => void;
  busy?: boolean;
  disabled?: boolean;
};
function LocalCameraConnector({
  onConnect,
  busy = false,
  disabled = false,
}: ConnectorProps) {
  const [inventory, setInventory] = useState<LocalCameraInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [name, setName] = useState("");
  const request = useRef<AbortController | null>(null);
  const locked = busy || disabled;
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setInventory(null);
    setDeviceId("");
    setError("");
    setLoading(true);
    try {
      const result = await listLocalCameras(controller.signal);
      if (!controller.signal.aborted) setInventory(result);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "The camera list could not be loaded. Refresh to try again.",
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);
  const selected = inventory?.supported
    ? inventory.devices.find((device) => device.id === deviceId)
    : undefined;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || loading || !selected) return;
    onConnect({
      type: "usb",
      deviceId: selected.id,
      name: name.trim() || selected.name,
    });
  }
  return (
    <form
      className="camera-connector background-local-connector"
      onSubmit={submit}
      aria-busy={loading || busy}
    >
      <p className="camera-mode-description">
        Connect a USB, built-in or capture-card camera attached to the computer
        running Traffic Control. Keep the application open while monitoring.
      </p>
      <div className="background-local-toolbar">
        <span>Cameras on this computer</span>
        <button
          type="button"
          className="button secondary"
          disabled={locked || loading}
          onClick={() => void refresh()}
          aria-label="Refresh local cameras"
        >
          <RefreshCw size={13} className={loading ? "is-refreshing" : ""} />
          Refresh
        </button>
      </div>
      {loading ? (
        <p className="background-local-message" role="status">
          Looking for connected cameras…
        </p>
      ) : error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : !inventory?.supported ? (
        <p className="background-local-message" role="status">
          {inventory?.reason ||
            "Background USB capture is unavailable on this computer. Use a browser camera in Live overview."}
        </p>
      ) : inventory.devices.length === 0 ? (
        <p className="background-local-message" role="status">
          {inventory.reason ||
            "No cameras found. Connect a camera to this computer, then refresh."}
        </p>
      ) : (
        <>
          <label>
            Local camera
            <select
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
              disabled={locked}
              required
            >
              <option value="">Select a camera…</option>
              {inventory.devices.map((device, index) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                  {inventory.devices.some(
                    (other) =>
                      other.id !== device.id && other.name === device.name,
                  )
                    ? ` · Camera ${index + 1}`
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Camera name <span>optional</span>
            <input
              disabled={locked}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={selected?.name || "e.g. East approach · Camera 02"}
              maxLength={80}
            />
          </label>
        </>
      )}
      <button
        type="submit"
        className="button primary full-width"
        disabled={locked || loading || !selected}
      >
        <Camera size={16} />
        {busy ? "Connecting…" : "Start background monitoring"}
        <ArrowUpRight size={15} />
      </button>
      <p className="background-local-message">
        Listing cameras does not activate them. Choose a camera and start
        monitoring to open its video feed.
      </p>
    </form>
  );
}
export default function BackgroundCameraConnector({
  onConnect,
  busy = false,
  disabled = false,
}: ConnectorProps) {
  const [source, setSource] = useState<"network" | "usb">("network");
  const locked = busy || disabled;
  return (
    <div className="background-camera-connector">
      <div
        className="background-source-choice"
        role="group"
        aria-label="Background camera source"
      >
        <button
          type="button"
          aria-pressed={source === "network"}
          disabled={locked}
          onClick={() => setSource("network")}
        >
          <Network size={15} />
          Network
        </button>
        <button
          type="button"
          aria-pressed={source === "usb"}
          disabled={locked}
          onClick={() => setSource("usb")}
        >
          <Usb size={15} />
          USB camera
        </button>
      </div>
      {source === "usb" ? (
        <LocalCameraConnector
          onConnect={onConnect}
          busy={busy}
          disabled={disabled}
        />
      ) : (
        <CameraConnector
          onConnect={onConnect}
          submitLabel="Start background monitoring"
          busy={busy}
          disabled={disabled}
        />
      )}
    </div>
  );
}
