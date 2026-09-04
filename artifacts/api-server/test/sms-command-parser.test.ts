import assert from "node:assert/strict";
import { normalizeInboundSmsBody, normalizeSmsKeyword, parseInboundSmsCommand } from "../server/sms-command-parser";

function command(input: string) {
  return parseInboundSmsCommand(normalizeInboundSmsBody(input));
}

assert.equal(command("I got sent the other one but i mistakenly opened it"), "unknown");
assert.equal(command("n"), "unknown");
assert.equal(command("y"), "unknown");
assert.equal(command("thanks"), "unknown");
assert.equal(command("open"), "unknown");

assert.equal(command("yes"), "yes");
assert.equal(command(" YES "), "yes");
assert.equal(command("yes!!!"), "yes");
assert.equal(command("no"), "no");
assert.equal(command("help"), "help");
assert.equal(command("sos"), "sos");
assert.equal(command("  SOS  "), "sos");
assert.equal(command("help me"), "unknown");
assert.equal(command("not okay"), "unknown");
assert.equal(command("ok"), "unknown");
assert.equal(command("safe"), "unknown");

assert.equal(command("handling"), "guardian_handling");
assert.equal(command("i got this"), "guardian_handling");
assert.equal(command("cant reach"), "guardian_cant_reach");
assert.equal(command("can't reach"), "guardian_cant_reach");

assert.equal(normalizeInboundSmsBody("  Can't   Reach!!! "), "can't reach");
assert.equal(normalizeSmsKeyword("STOP!!!"), "stop");
assert.equal(normalizeSmsKeyword("stop all"), "stopall");

console.log("sms command parser tests passed");

