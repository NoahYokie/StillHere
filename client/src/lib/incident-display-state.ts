export type IncidentDisplayState = "Active" | "Quiet" | "Concern" | "Resolved" | "PastAlert";

const PAST_ALERT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface IncidentDisplayInput {
  safetyState?: string | null;
  hasOpenIncident?: boolean | null;
  incident?: {
    status?: string | null;
    resolvedAt?: string | Date | null;
  } | null;
  resolvedAt?: string | Date | null;
  now?: Date | number;
}

function toTime(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function getIncidentDisplayState(input: IncidentDisplayInput): IncidentDisplayState {
  const incidentStatus = input.incident?.status;
  if (incidentStatus === "resolved" || input.resolvedAt || input.incident?.resolvedAt) {
    const nowMs = typeof input.now === "number"
      ? input.now
      : input.now instanceof Date
        ? input.now.getTime()
        : Date.now();
    const resolvedAtMs = toTime(input.resolvedAt ?? input.incident?.resolvedAt);
    if (resolvedAtMs !== null && nowMs - resolvedAtMs >= PAST_ALERT_THRESHOLD_MS) {
      return "PastAlert";
    }
    return "Resolved";
  }

  if (input.hasOpenIncident || incidentStatus === "open" || incidentStatus === "paused" || input.safetyState === "concern") {
    return "Concern";
  }

  if (input.safetyState === "quiet") return "Quiet";
  return "Active";
}

export function isResolvedDisplayState(state: IncidentDisplayState): boolean {
  return state === "Resolved" || state === "PastAlert";
}
