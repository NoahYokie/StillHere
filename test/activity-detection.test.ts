import assert from "node:assert/strict";
import { detectActivityFromSpeed, formatActivity } from "../shared/activity-detection";

const kmh = (value: number) => value / 3.6;

assert.equal(detectActivityFromSpeed(null), "stationary");
assert.equal(detectActivityFromSpeed(kmh(3)), "walking");
assert.equal(detectActivityFromSpeed(kmh(10)), "running");
assert.equal(detectActivityFromSpeed(kmh(20)), "cycling");
assert.equal(detectActivityFromSpeed(kmh(35)), "scooter");
assert.equal(detectActivityFromSpeed(kmh(60)), "driving");
assert.equal(detectActivityFromSpeed(kmh(110)), "transit");

assert.equal(formatActivity("cycling"), "Bike");
assert.equal(formatActivity("scooter"), "Scooter");
assert.equal(formatActivity("transit"), "Train / transit");

console.log("activity-detection tests passed");
