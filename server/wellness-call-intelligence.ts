export type WellnessCallStatus =
  | "placed"
  | "answered_human"
  | "voicemail_left"
  | "safe"
  | "help"
  | "no_response"
  | "failed";

export interface WellnessCallClassification {
  status: Exclude<WellnessCallStatus, "placed" | "safe" | "help"> | null;
  detail: string | null;
  shouldAccelerateContacts: boolean;
}

export function normalizeTwilioValue(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function isMachineAnsweredBy(answeredBy: unknown): boolean {
  const normalized = normalizeTwilioValue(answeredBy);
  return normalized.includes("machine") || normalized === "fax";
}

export function isHumanAnsweredBy(answeredBy: unknown): boolean {
  return normalizeTwilioValue(answeredBy) === "human";
}

export function shouldAccelerateContactEscalation(status: string | null | undefined): boolean {
  return status === "voicemail_left" || status === "no_response" || status === "failed";
}

export function classifyWellnessStatusCallback(input: {
  callStatus?: unknown;
  answeredBy?: unknown;
  durationSeconds?: number;
}): WellnessCallClassification {
  const callStatus = normalizeTwilioValue(input.callStatus);
  const answeredBy = normalizeTwilioValue(input.answeredBy);
  const durationSeconds = Number.isFinite(input.durationSeconds)
    ? Math.max(0, Number(input.durationSeconds))
    : 0;

  if (isMachineAnsweredBy(answeredBy)) {
    return {
      status: "voicemail_left",
      detail: "Wellness call connected to voicemail. We attempted to leave a safety message. No safety confirmation received.",
      shouldAccelerateContacts: true,
    };
  }

  // AMD returned "human" — call connected, but this does NOT confirm a human
  // answered. Only keypad confirmation counts as safety confirmation.
  if (isHumanAnsweredBy(answeredBy)) {
    return {
      status: "answered_human",
      detail: "Call connected. Waiting for safety confirmation.",
      shouldAccelerateContacts: false,
    };
  }

  if (callStatus === "no-answer") {
    return {
      status: "no_response",
      detail: "Wellness call was not answered. No safety confirmation received.",
      shouldAccelerateContacts: true,
    };
  }

  if (["busy", "failed", "canceled"].includes(callStatus)) {
    return {
      status: "failed",
      detail: `Wellness call ended with status: ${callStatus}. No safety confirmation received.`,
      shouldAccelerateContacts: true,
    };
  }

  if (callStatus === "completed" && durationSeconds === 0) {
    return {
      status: "no_response",
      detail: "Wellness call completed with no connected duration. No safety confirmation received.",
      shouldAccelerateContacts: true,
    };
  }

  if (callStatus === "completed" && durationSeconds > 0 && !answeredBy) {
    return {
      status: "no_response",
      detail: "Wellness call connected but no keypad confirmation was received.",
      shouldAccelerateContacts: true,
    };
  }

  return { status: null, detail: null, shouldAccelerateContacts: false };
}

export function classifyWellnessTwiMLAnswer(answeredBy: unknown): "machine" | "human" | "unknown" {
  if (isMachineAnsweredBy(answeredBy)) return "machine";
  if (isHumanAnsweredBy(answeredBy)) return "human";
  return "unknown";
}
