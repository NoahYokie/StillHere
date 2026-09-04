export type InboundSmsCommand =
  | "yes"
  | "no"
  | "help"
  | "sos"
  | "guardian_handling"
  | "guardian_cant_reach"
  | "unknown";

const SURROUNDING_PUNCTUATION_RE = /^[\s"'.,!?;:()[\]{}<>]+|[\s"'.,!?;:()[\]{}<>]+$/g;

export function normalizeInboundSmsBody(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .replace(SURROUNDING_PUNCTUATION_RE, "");
}

export function normalizeSmsKeyword(raw: unknown): string {
  return normalizeInboundSmsBody(raw).replace(/[^a-z]/g, "");
}

export function parseInboundSmsCommand(normalizedBody: string): InboundSmsCommand {
  switch (normalizedBody) {
    case "yes":
      return "yes";
    case "no":
      return "no";
    case "help":
      return "help";
    case "sos":
      return "sos";
    case "handling":
    case "i got this":
      return "guardian_handling";
    case "cant reach":
    case "can't reach":
      return "guardian_cant_reach";
    default:
      return "unknown";
  }
}

