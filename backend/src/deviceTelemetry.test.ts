import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceTelemetrySchema } from "./deviceTelemetry";

test("accepts a gateway packet containing tank, switches, flow, pump, and power readings", () => {
  const packet = deviceTelemetrySchema.parse({
    deviceId: "campus-gateway-1",
    recordedAt: "2026-11-22T11:00:00Z",
    tanks: [{
      tankId: "64a000000000000000000101",
      waterLevelLiter: 18000,
      pressureKpa: 42.5,
      lowLevelSwitch: false,
      highLevelSwitch: false,
      leakDetected: false,
    }],
    flowMeters: [{
      meterCode: "FM-MB-IN",
      flowRateLpm: 24.5,
      totalizerLiter: 283410,
    }],
    pumps: [{
      pumpCode: "P-MB1",
      running: true,
      fault: false,
      overcurrentDetected: false,
      currentA: 3.2,
      voltageV: 230,
      powerFactor: 0.91,
      activePowerKw: 0.68,
      energyKwh: 152.7,
    }],
  });
  assert.equal(packet.flowMeters[0].meterCode, "FM-MB-IN");
  assert.equal(packet.pumps[0].currentA, 3.2);
});

test("allows a gateway to report only pump data or only tank data", () => {
  assert.equal(deviceTelemetrySchema.safeParse({
    deviceId: "gateway",
    pumps: [{ pumpCode: "P-MB1", fault: true }],
  }).success, true);
  assert.equal(deviceTelemetrySchema.safeParse({
    deviceId: "gateway",
    flowMeters: [{ meterCode: "FM-MB-IN", totalizerLiter: 100 }],
  }).success, true);
  assert.equal(deviceTelemetrySchema.safeParse({
    deviceId: "gateway",
    tanks: [{ tankId: "64a000000000000000000101", lowLevelSwitch: true }],
  }).success, true);
});

test("rejects unknown devices, duplicate readings, and invalid electrical values", () => {
  assert.equal(deviceTelemetrySchema.safeParse({
    deviceId: "gateway",
    tanks: [{ tankId: "64a000000000000000000101", waterLevelLiter: -1 }],
  }).success, false);
  assert.equal(deviceTelemetrySchema.safeParse({
    deviceId: "gateway",
    pumps: [{ pumpCode: "P-MB1", powerFactor: 1.4 }],
  }).success, false);
  assert.equal(deviceTelemetrySchema.safeParse({
    deviceId: "gateway",
    flowMeters: [{ meterCode: "FM-MB-IN" }],
  }).success, false);
  assert.equal(deviceTelemetrySchema.safeParse({
    deviceId: "gateway",
    tanks: [
      { tankId: "64a000000000000000000101", waterLevelLiter: 10 },
      { tankId: "64a000000000000000000101", lowLevelSwitch: true },
    ],
  }).success, false);
});
