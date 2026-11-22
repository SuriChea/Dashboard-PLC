import { z } from "zod";

const objectId = /^[a-f\d]{24}$/i;
const nonNegative = z.number().finite().nonnegative();

const tankTelemetry = z.object({
  tankId: z.string().regex(objectId),
  waterLevelLiter: nonNegative.optional(),
  pressureKpa: nonNegative.optional(),
  lowLevelSwitch: z.boolean().optional(),
  highLevelSwitch: z.boolean().optional(),
  temperature: z.number().finite().optional(),
  leakDetected: z.boolean().optional(),
}).strict().superRefine((tank, context) => {
  if (Object.keys(tank).length === 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Tank telemetry must contain at least one reading" });
  }
});

const pumpTelemetry = z.object({
  pumpCode: z.string().trim().min(1).max(50),
  running: z.boolean().optional(),
  fault: z.boolean().optional(),
  faultCode: z.string().trim().min(1).max(100).optional(),
  overcurrentDetected: z.boolean().optional(),
  flowRateLpm: nonNegative.optional(),
  currentA: nonNegative.optional(),
  voltageV: nonNegative.optional(),
  powerFactor: z.number().finite().min(0).max(1).optional(),
  activePowerKw: nonNegative.optional(),
  energyKwh: nonNegative.optional(),
}).strict().superRefine((pump, context) => {
  if (Object.keys(pump).length === 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Pump telemetry must contain at least one reading" });
  }
});

const flowMeterTelemetry = z.object({
  meterCode: z.string().trim().min(1).max(50),
  flowRateLpm: nonNegative.optional(),
  totalizerLiter: nonNegative.optional(),
}).strict().superRefine((meter, context) => {
  if (meter.flowRateLpm === undefined && meter.totalizerLiter === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Flow meter telemetry must include flow rate or totalizer" });
  }
});

export const deviceTelemetrySchema = z.object({
  deviceId: z.string().trim().min(1).max(100),
  recordedAt: z.coerce.date().optional(),
  tanks: z.array(tankTelemetry).max(100).default([]),
  flowMeters: z.array(flowMeterTelemetry).max(100).default([]),
  pumps: z.array(pumpTelemetry).max(100).default([]),
}).strict().superRefine((packet, context) => {
  if (packet.tanks.length === 0 && packet.flowMeters.length === 0 && packet.pumps.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide at least one tank, flow meter, or pump reading" });
  }
  const tankIds = packet.tanks.map((tank) => tank.tankId);
  if (new Set(tankIds).size !== tankIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Tank ids must not be duplicated in a packet" });
  }
  const pumpCodes = packet.pumps.map((pump) => pump.pumpCode);
  if (new Set(pumpCodes).size !== pumpCodes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Pump codes must not be duplicated in a packet" });
  }
  const meterCodes = packet.flowMeters.map((meter) => meter.meterCode);
  if (new Set(meterCodes).size !== meterCodes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Flow meter codes must not be duplicated in a packet" });
  }
});

export type DeviceTelemetry = z.infer<typeof deviceTelemetrySchema>;
