import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateTotalizerFlowRate, calculateUsageLiter, splitUsageByUtcDay } from "./waterUsage";

test("integrates changing flow over the actual interval", () => {
  assert.equal(calculateUsageLiter(10, 20, 120000), 30);
});

test("does not invent usage for a zero-length interval", () => {
  assert.equal(calculateUsageLiter(60, 60, 0), 0);
});

test("rejects negative sensor values", () => {
  assert.throws(() => calculateUsageLiter(-1, 2, 60000));
});

test("derives average flow from the meter totalizer delta", () => {
  assert.equal(calculateTotalizerFlowRate(1000, 1120, 300000), 24);
  assert.throws(() => calculateTotalizerFlowRate(1120, 1000, 300000));
  assert.throws(() => calculateTotalizerFlowRate(1000, 1000, 0));
});

test("splits interval usage across UTC midnight without losing volume", () => {
  const segments = splitUsageByUtcDay(
    new Date("2026-01-01T23:30:00Z"),
    new Date("2026-01-02T00:30:00Z"),
    12,
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].liters, 360);
  assert.equal(segments[1].liters, 360);
  assert.equal(segments.reduce((total, segment) => total + segment.liters, 0), 720);
});
