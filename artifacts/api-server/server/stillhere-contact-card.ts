export const STILLHERE_CONTACT_NAME = "StillHere Safety";
export const STILLHERE_CONTACT_ORG = "StillHere";
export const STILLHERE_CONTACT_NOTE = "Emergency wellness and safety check-in line.";
export const PRE_CALL_SMS_BODY = "STILLHERE: We are calling you now regarding your missed safety check-in. Please answer to confirm you are safe.";

function escapeVCardText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export function buildStillHereContactVCard(phoneNumber: string): string {
  const phone = phoneNumber.trim();
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapeVCardText(STILLHERE_CONTACT_NAME)}`,
    `ORG:${escapeVCardText(STILLHERE_CONTACT_ORG)}`,
    `TEL;TYPE=VOICE,CELL:${escapeVCardText(phone)}`,
    `NOTE:${escapeVCardText(STILLHERE_CONTACT_NOTE)}`,
    "END:VCARD",
    "",
  ];
  return lines.join("\r\n");
}
