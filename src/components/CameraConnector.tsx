import { useState, type FormEvent } from "react";
import {
  Cable,
  Globe2,
  Radio,
  ShieldCheck,
  Video,
  ArrowUpRight,
} from "lucide-react";
import type { NetworkCameraConfig } from "../useTraffic";
import "./camera-connector.css";
export default function CameraConnector({
  onConnect,
  submitLabel = "Connect live stream",
  busy = false,
  disabled = false,
}: {
  onConnect: (config: NetworkCameraConfig) => void;
  submitLabel?: string;
  busy?: boolean;
  disabled?: boolean;
}) {
  const locked = busy || disabled;
  const [type, setType] = useState<NetworkCameraConfig["type"]>("nest");
  const [url, setUrl] = useState("https://video.nest.com/live/2VNgNDSgKs");
  const [name, setName] = useState(""),
    [host, setHost] = useState(""),
    [port, setPort] = useState("80"),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState("");
  const modes = [
    { id: "nest", label: "Nest shared", icon: Video },
    { id: "url", label: "Web stream", icon: Globe2 },
    { id: "rtsp", label: "RTSP", icon: Radio },
    { id: "onvif", label: "ONVIF", icon: Cable },
  ] as const;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (locked) return;
    setError("");
    if (type === "onvif") {
      if (!host.trim()) {
        setError("Enter the camera IP address or hostname.");
        return;
      }
      if (
        !Number.isInteger(Number(port)) ||
        Number(port) < 1 ||
        Number(port) > 65535
      ) {
        setError("Enter a camera port between 1 and 65535.");
        return;
      }
    } else {
      try {
        const parsed = new URL(url);
        if (
          type === "nest" &&
          (parsed.protocol !== "https:" ||
            parsed.hostname !== "video.nest.com" ||
            parsed.username ||
            parsed.password ||
            parsed.search ||
            !/^\/live\/[A-Za-z0-9]{6,64}\/?$/.test(parsed.pathname))
        )
          throw new Error();
        if (type === "rtsp" && !["rtsp:", "rtsps:"].includes(parsed.protocol))
          throw new Error();
        if (type === "url" && !["http:", "https:"].includes(parsed.protocol))
          throw new Error();
      } catch {
        setError(
          type === "nest"
            ? "Enter a public Nest link such as https://video.nest.com/live/…"
            : type === "rtsp"
              ? "Enter an rtsp:// or rtsps:// camera stream URL."
              : "Enter the direct HTTP(S) stream URL (HLS, MJPEG or video).",
        );
        return;
      }
    }
    onConnect({
      type,
      ...(type === "onvif"
        ? { host: host.trim(), port: Number(port) }
        : { url: url.trim() }),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(type !== "nest" && username ? { username } : {}),
      ...(type !== "nest" && password ? { password } : {}),
    });
  }
  return (
    <form className="camera-connector" onSubmit={submit} aria-busy={busy}>
      <div
        className="camera-modes"
        role="group"
        aria-label="Camera connection type"
      >
        {modes.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            disabled={locked}
            key={id}
            className={type === id ? "chosen" : ""}
            aria-pressed={type === id}
            onClick={() => {
              setType(id);
              setError("");
              setUrl(
                id === "nest" ? "https://video.nest.com/live/2VNgNDSgKs" : "",
              );
            }}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
      </div>
      <div className="camera-mode-description">
        {type === "nest"
          ? "Connect a publicly shared Nest Cam. The live feed is resolved from its sharing link."
          : type === "url"
            ? "Use a direct HLS (.m3u8), MJPEG, or HTTP video stream. The local gateway makes it readable by the detector."
            : type === "rtsp"
              ? "Connect an IP camera or NVR using its RTSP stream address. Video is decoded by the local gateway."
              : "Connect to an ONVIF camera by IP address. The gateway negotiates its media profile and RTSP video stream."}
      </div>
      {type === "onvif" ? (
        <div className="camera-host-row">
          <label>
            Camera IP / hostname
            <input
              disabled={locked}
              autoComplete="off"
              placeholder="192.168.1.100"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              required
            />
          </label>
          <label>
            ONVIF port
            <input
              disabled={locked}
              aria-label="ONVIF port"
              type="number"
              min="1"
              max="65535"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              required
            />
          </label>
        </div>
      ) : (
        <label>
          {type === "nest"
            ? "Public Nest sharing link"
            : type === "rtsp"
              ? "RTSP stream URL"
              : "Direct video stream URL"}
          <input
            disabled={locked}
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={
              type === "nest"
                ? "https://video.nest.com/live/…"
                : type === "rtsp"
                  ? "rtsp://192.168.1.100:554/stream1"
                  : "https://camera.example/live/index.m3u8"
            }
            required
          />
        </label>
      )}
      {type !== "nest" && (
        <div className="camera-auth-row">
          <label>
            Username <span>optional</span>
            <input
              disabled={locked}
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Camera username"
            />
          </label>
          <label>
            Password <span>optional</span>
            <input
              disabled={locked}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Camera password"
            />
          </label>
        </div>
      )}
      <label>
        Camera name <span>optional</span>
        <input
          disabled={locked}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={
            type === "nest"
              ? "Use the Nest camera name"
              : "e.g. East approach · Camera 02"
          }
          maxLength={80}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="button primary full-width"
        disabled={locked}
      >
        <Video size={16} />
        {busy ? "Connecting…" : submitLabel}
        <ArrowUpRight size={15} />
      </button>
      <div className="modal-note">
        <ShieldCheck size={17} />
        <span>
          Credentials are used locally for this connection and are not saved.
          Use a camera or public feed you’re allowed to access. Calibrate its
          road plane before measuring speeds.
        </span>
      </div>
    </form>
  );
}
