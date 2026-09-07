import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { IncidentTelephony, containmentMessage, unboundMessage } from "./incident-telephony";

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const say = (value: string) => `<Say voice="Polly.Joanna-Neural">${xml(value)}</Say>`;
const response = (res: Response, body: string) => res.type("text/xml").send(`<Response>${body}</Response>`);
const scalar = (value: unknown) => typeof value === "string" ? value : undefined;

export function wellnessActionUrl(path: string, incidentId: string, attemptId?: string, turn: string = randomUUID()) {
  const query = new URLSearchParams({ incidentId, turn });
  if (attemptId) query.set("attemptId", attemptId);
  return `/api/wellness-call/${path}?${query}`;
}

export function createWellnessContactHandlers(deps: {
  ledger: IncidentTelephony;
  voiceFrom: () => string | undefined | null;
  resolve: (userId: string, incidentId: string) => Promise<{ resolved: boolean }>;
}) {
  const { ledger } = deps;
  async function bind(req: Request, type: string) {
    return ledger.receive({ incidentId: scalar(req.query.incidentId), attemptId: scalar(req.query.attemptId), type, turn: scalar(req.query.turn), body: req.body || {} });
  }
  async function menu(res: Response, incidentId: string, attemptId: string | undefined, callSid: string) {
    const next = await ledger.nextContact(incidentId, callSid);
    if (next.kind !== "available") return response(res, say(next.message) + "<Hangup/>");
    const action = wellnessActionUrl("help-followup", incidentId, attemptId);
    return response(res, say(next.message) + `<Gather numDigits="1" action="${xml(action)}" method="POST" timeout="20" actionOnEmptyResult="true">${say(`Press 1 to connect to ${next.contact.displayName}. Press 0 for emergency services guidance.`)}</Gather>` + say(containmentMessage) + "<Hangup/>");
  }
  function handler(type: string, work: (req: Request, res: Response, binding: NonNullable<Awaited<ReturnType<typeof bind>>>) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
      try {
        const binding = await bind(req, type);
        if (!binding || binding.incident.status !== "open") return response(res, say(unboundMessage) + "<Hangup/>");
        return await work(req, res, binding);
      } catch (error) {
        console.error("[WELLNESS_CONTACT_CALLBACK_ERROR]", type, error instanceof Error ? error.message : "unknown");
        // Do not acknowledge failed durable ingestion as successfully processed.
        return res.status(503).type("text/xml").send(`<Response>${say(unboundMessage)}<Hangup/></Response>`);
      }
    };
  }
  const helpFollowup = handler("help-followup", async (req, res, b) => {
    const digits = scalar(req.body.Digits) || "";
    if (digits !== "1") {
      const next = await ledger.nextContact(b.incident.id, b.raw.callSid!);
      return response(res, say(next.kind === "available" ? containmentMessage : next.message) + "<Hangup/>");
    }
    const from = deps.voiceFrom();
    if (!from) return response(res, say(containmentMessage) + "<Hangup/>");
    const next = await ledger.nextContact(b.incident.id, b.raw.callSid!, true, scalar(req.query.turn) || "legacy");
    if (next.kind !== "reserved") return response(res, say(next.message) + "<Hangup/>");
    const action = wellnessActionUrl("dial-result", b.incident.id, next.attempt.id);
    const status = wellnessActionUrl("contact-status", b.incident.id, next.attempt.id);
    return response(res, `<Dial timeout="25" callerId="${xml(from)}" answerOnBridge="true" action="${xml(action)}" method="POST"><Number statusCallback="${xml(status)}" statusCallbackMethod="POST" statusCallbackEvent="initiated ringing answered completed">${xml(next.contact.destination)}</Number></Dial>`);
  });
  const dialResult = handler("dial-result", async (req, res, b) => {
    const status = b.raw.dialCallStatus;
    // Completed is a provider fact, not proof of human receipt or safety.
    // Duration never changes this statement to "could not reach".
    const fact = status === "completed" ? "The contact call has completed."
      : ["busy", "no-answer", "failed", "canceled"].includes(status || "") ? `The contact call returned ${status}.`
      : "We cannot confirm the outcome of the contact call.";
    const action = wellnessActionUrl("post-contact-followup", b.incident.id, b.attempt?.id, "after:" + (scalar(req.query.turn) || b.attempt?.id || "legacy"));
    return response(res, say(fact) + `<Gather numDigits="1" action="${xml(action)}" method="POST" timeout="15" actionOnEmptyResult="true">${say("Press 1 if you are safe. Press 2 if you still need help.")}</Gather>` + say(containmentMessage) + "<Hangup/>");
  });
  const postContactFollowup = handler("post-contact-followup", async (req, res, b) => {
    const digits = scalar(req.body.Digits) || "";
    if (digits === "1") {
      const result = await deps.resolve(b.incident.userId, b.incident.id);
      return response(res, say(result.resolved ? "Thank you for confirming that you are safe." : unboundMessage) + "<Hangup/>");
    }
    if (digits === "2") {
      const updated = await ledger.needsHelp(b.incident.id, b.incident.userId, { callSid: b.raw.callSid!, turn: scalar(req.query.turn) || "legacy", type: "post-contact-followup" });
      if (!updated.length) return response(res, say(unboundMessage) + "<Hangup/>");
    }
    return menu(res, b.incident.id, b.attempt?.id, b.raw.callSid!);
  });
  const comfort = handler("comfort", async (_req, res, b) => menu(res, b.incident.id, b.attempt?.id, b.raw.callSid!));
  const contactStatus = async (req: Request, res: Response) => {
    try {
      await bind(req, "contact-status");
      return response(res, "");
    } catch (error) {
      console.error("[WELLNESS_CONTACT_STATUS_ERROR]", error instanceof Error ? error.message : "unknown");
      return res.status(503).send("");
    }
  };
  return { helpFollowup, dialResult, postContactFollowup, comfort, contactStatus };
}
