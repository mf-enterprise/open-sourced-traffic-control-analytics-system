import { ScanLine } from "lucide-react";
import type {
  MonitorFrame,
  AutomaticPlateStatus,
} from "./backgroundMonitorClient";
export default function AutomaticPlates({
  frame,
  status,
  enabled,
  disabled,
  stale,
  onToggle,
}: {
  frame: MonitorFrame | null;
  status?: AutomaticPlateStatus;
  enabled: boolean;
  disabled: boolean;
  stale: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const vehicles =
    frame?.tracks.filter((track) =>
      ["car", "truck", "bus", "motorcycle"].includes(track.className),
    ) ?? [];
  return (
    <section
      className="background-panel background-plates"
      aria-label="Automatic registration reads"
    >
      <header>
        <div>
          <span className="eyebrow">VEHICLE DETAILS</span>
          <h2>Automatic registration reads</h2>
        </div>
        <button
          className="background-plate-toggle"
          role="switch"
          aria-checked={enabled}
          aria-label="Automatic registration reads"
          disabled={disabled}
          onClick={() => onToggle(!enabled)}
        >
          <i />
          <span>{enabled ? "On" : "Off"}</span>
        </button>
      </header>
      <div
        className={`background-plate-status ${status?.state === "unavailable" ? "has-error" : ""}`}
      >
        <ScanLine size={16} />
        <span>
          {!enabled
            ? "Automatic reads are off."
            : status?.reason ||
              "Reads start with continuous camera monitoring."}
        </span>
      </div>
      {enabled && vehicles.length > 0 ? (
        <div
          className="background-plate-list"
          aria-label={
            stale
              ? "Registration reads from retained frame"
              : "Registration reads for visible vehicles"
          }
        >
          {vehicles.map((track) => {
            const reading = frame?.plateReadings?.find(
              (item) =>
                item.trackId === track.id &&
                Number.isFinite(item.sourceTimestamp) &&
                item.sourceTimestamp <= frame.sourceTimestamp,
            );
            const candidate =
              reading?.state === "candidate" &&
              reading.samples >= 2 &&
              reading.plate
                ? reading.plate
                : null;
            const age =
              reading && frame
                ? Math.max(0, frame.sourceTimestamp - reading.sourceTimestamp)
                : 0;
            return (
              <div
                className="background-plate-row"
                key={track.id}
                title={
                  reading
                    ? `Read source time: ${reading.sourceTimestamp.toFixed(3)}s · captured ${reading.observedAt}`
                    : undefined
                }
              >
                <div className="background-plate-identity">
                  <strong>#{track.id}</strong>
                  <span>{track.className}</span>
                </div>
                <div className="background-plate-result">
                  <div>
                    <strong className={candidate ? "has-candidate" : ""}>
                      {candidate ||
                        (reading?.state === "conflict"
                          ? "Conflicting reads"
                          : reading?.state === "pending"
                            ? "Reading…"
                            : reading?.state === "unreadable"
                              ? "Unreadable"
                              : "Awaiting detail")}
                    </strong>
                    {candidate && (
                      <span className="background-plate-unverified">
                        Unverified
                      </span>
                    )}
                  </div>
                  <small>
                    {candidate
                      ? `${reading!.samples} matching reads · ${age.toFixed(1)}s before this frame`
                      : reading?.reason ||
                        "Waiting for a clear, large enough vehicle view."}
                  </small>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        enabled && (
          <p className="background-plate-empty">
            Readable registrations will appear beside their vehicle ID.
          </p>
        )
      )}
      <footer>
        {stale && frame && (
          <span className="background-plate-retained">
            Retained frame · not a current observation.
          </span>
        )}
        A candidate needs matching text in separate frames. Small or unclear
        plates stay unreadable. Candidates require visual review and do not fill
        a ticket.
      </footer>
    </section>
  );
}
