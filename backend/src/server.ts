import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { deviceTelemetrySchema } from "./deviceTelemetry";
import { calculateTotalizerFlowRate, splitUsageByUtcDay } from "./waterUsage";

const prisma = new PrismaClient();
const app = express();
const port = Number(process.env.PORT ?? 4000);
const objectId = /^[a-f\d]{24}$/i;

app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? "http://localhost:3000" }));
app.use(express.json({ limit: "1mb" }));
app.use((request, response, next) => {
  const startedAt = Date.now();
  response.on("finish", () => {
    console.info(`${new Date().toISOString()} ${request.method} ${request.path} ${response.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<unknown>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function parseId(value: string, response: Response) {
  if (!objectId.test(value)) {
    response.status(400).json({ error: "Invalid object id" });
    return false;
  }
  return true;
}

function authenticateDevice(request: Request, response: Response, next: NextFunction) {
  const expected = process.env.DEVICE_INGEST_TOKEN;
  const expectedBuffer = Buffer.from(expected ?? "");
  if (expectedBuffer.length < 32) {
    return response.status(503).json({ error: "Device ingestion requires DEVICE_INGEST_TOKEN to contain at least 32 characters" });
  }
  const authorization = request.header("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const providedBuffer = Buffer.from(provided);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return response.status(401).json({ error: "Invalid device token" });
  }
  next();
}

function dayStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function monthStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function levelStatus(percent: number, critical: number, low: number) {
  if (percent < critical) return "CRITICAL" as const;
  if (percent < low) return "WARNING" as const;
  return "NORMAL" as const;
}

async function getSettings() {
  const singletonId = "64a000000000000000000099";
  return prisma.systemSettings.upsert({
    where: { id: singletonId },
    create: { id: singletonId },
    update: {},
  });
}

async function evaluateAutomaticPumps(
  buildingId: string,
  levelPercent: number,
  settings: { autoStartThreshold: number; autoStopThreshold: number; emergencyStop: boolean },
) {
  const pumps = await prisma.pump.findMany({ where: { buildingId, controlMode: "AUTO" } });
  const now = new Date();
  for (const pump of pumps) {
    if (levelPercent <= settings.autoStartThreshold && !settings.emergencyStop && pump.isOnline && pump.status === "OFF") {
      const flowRate = pump.flowRate || 85;
      await prisma.pump.update({ where: { id: pump.id }, data: { status: "ON", flowRate, updatedAt: now } });
      await prisma.pumpLog.create({
        data: {
          pumpId: pump.id, buildingId, action: "START", controlMode: "AUTO",
          reason: `Automatic start: tank level at ${levelPercent.toFixed(1)}%`,
          flowRate, startedAt: now,
        },
      });
    } else if (levelPercent >= settings.autoStopThreshold && pump.status === "ON") {
      const lastStart = await prisma.pumpLog.findFirst({
        where: { pumpId: pump.id, action: "START", stoppedAt: null },
        orderBy: { startedAt: "desc" },
      });
      await prisma.pump.update({ where: { id: pump.id }, data: { status: "OFF", flowRate: 0, updatedAt: now } });
      if (lastStart) {
        await prisma.pumpLog.update({
          where: { id: lastStart.id },
          data: { stoppedAt: now, durationMinutes: Math.max(0, (now.getTime() - (lastStart.startedAt?.getTime() ?? now.getTime())) / 60000) },
        });
      }
      await prisma.pumpLog.create({
        data: {
          pumpId: pump.id, buildingId, action: "STOP", controlMode: "AUTO",
          reason: `Automatic stop: tank level at ${levelPercent.toFixed(1)}%`,
          flowRate: 0, stoppedAt: now,
        },
      });
    }
  }
}

async function refreshMonthlyBill(date: Date, waterPricePerM3: number) {
  const monthStartDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  const month = monthStartDate.getUTCMonth() + 1;
  const year = monthStartDate.getUTCFullYear();
  const [rows, buildings] = await Promise.all([
    prisma.dailyWaterUsage.findMany({ where: { date: { gte: monthStartDate, lt: nextMonth } } }),
    prisma.building.findMany(),
  ]);
  const usageByBuilding = new Map<string, number>();
  for (const row of rows) {
    usageByBuilding.set(row.buildingId, (usageByBuilding.get(row.buildingId) ?? 0) + row.totalUsageLiter);
  }
  const totalUsageLiter = rows.reduce((total, row) => total + row.totalUsageLiter, 0);
  const buildingBreakdown = buildings.map((building) => ({
    buildingId: building.id,
    buildingName: building.name,
    usageLiter: usageByBuilding.get(building.id) ?? 0,
  }));
  await prisma.monthlyWaterBill.upsert({
    where: { month_year: { month, year } },
    create: {
      month,
      year,
      totalUsageLiter,
      totalUsageM3: totalUsageLiter / 1000,
      totalCost: totalUsageLiter * waterPricePerM3 / 1000,
      averageDailyUsage: totalUsageLiter / Math.max(1, date.getUTCDate()),
      buildingBreakdown,
    },
    update: {
      totalUsageLiter,
      totalUsageM3: totalUsageLiter / 1000,
      totalCost: totalUsageLiter * waterPricePerM3 / 1000,
      averageDailyUsage: totalUsageLiter / Math.max(1, date.getUTCDate()),
      buildingBreakdown,
    },
  });
}

async function recordUsageInterval(
  buildingId: string,
  start: Date,
  end: Date,
  averageFlowRate: number,
  peakFlowRate: number,
  waterPricePerM3: number,
) {
  const segments = splitUsageByUtcDay(start, end, averageFlowRate);
  for (const segment of segments) {
    await prisma.dailyWaterUsage.upsert({
      where: { date_buildingId: { date: segment.date, buildingId } },
      create: {
        date: segment.date,
        buildingId,
        totalUsageLiter: segment.liters,
        averageFlowRate,
        peakFlowRate,
        estimatedCost: segment.liters * waterPricePerM3 / 1000,
      },
      update: {
        totalUsageLiter: { increment: segment.liters },
        averageFlowRate,
        peakFlowRate,
        estimatedCost: { increment: segment.liters * waterPricePerM3 / 1000 },
      },
    });
  }
  const billMonths = Array.from(new Map(segments.map((segment) => {
    const monthDate = new Date(Date.UTC(segment.date.getUTCFullYear(), segment.date.getUTCMonth(), 1));
    return [`${monthDate.getUTCFullYear()}-${monthDate.getUTCMonth()}`, segment.date];
  })).values());
  for (const billMonth of billMonths) await refreshMonthlyBill(billMonth, waterPricePerM3);
  return segments.reduce((total, segment) => total + segment.liters, 0);
}

app.get("/api/health", asyncRoute(async (_request, response) => {
  await prisma.$runCommandRaw({ ping: 1 });
  response.json({ status: "ok", database: "connected", service: "water-management-api" });
}));

app.get("/api/settings", asyncRoute(async (_request, response) => {
  response.json(await getSettings());
}));

app.put("/api/settings", asyncRoute(async (request, response) => {
  const schema = z.object({
    waterPricePerM3: z.number().nonnegative().optional(),
    lowWaterThreshold: z.number().min(0).max(100).optional(),
    criticalWaterThreshold: z.number().min(0).max(100).optional(),
    autoStartThreshold: z.number().min(0).max(100).optional(),
    autoStopThreshold: z.number().min(0).max(100).optional(),
    emergencyStop: z.boolean().optional(),
  }).refine((value) => Object.keys(value).length > 0, "Provide at least one setting");
  const data = schema.parse(request.body);
  const current = await getSettings();
  const critical = data.criticalWaterThreshold ?? current.criticalWaterThreshold;
  const low = data.lowWaterThreshold ?? current.lowWaterThreshold;
  const autoStart = data.autoStartThreshold ?? current.autoStartThreshold;
  const autoStop = data.autoStopThreshold ?? current.autoStopThreshold;
  if (critical >= low || autoStart >= autoStop) {
    return response.status(400).json({ error: "Critical/start thresholds must be lower than warning/stop thresholds" });
  }
  const updated = await prisma.systemSettings.update({ where: { id: current.id }, data });
  if (data.lowWaterThreshold !== undefined || data.criticalWaterThreshold !== undefined) {
    const tanks = await prisma.waterTank.findMany();
    await Promise.all(tanks.map((tank) => prisma.waterTank.update({
      where: { id: tank.id },
      data: { status: levelStatus(tank.currentLevelPercent, updated.criticalWaterThreshold, updated.lowWaterThreshold) },
    })));
  }
  if (data.emergencyStop && !current.emergencyStop) {
    const runningPumps = await prisma.pump.findMany({ where: { status: "ON" } });
    const now = new Date();
    for (const pump of runningPumps) {
      const lastStart = await prisma.pumpLog.findFirst({
        where: { pumpId: pump.id, action: "START", stoppedAt: null },
        orderBy: { startedAt: "desc" },
      });
      await prisma.pump.update({ where: { id: pump.id }, data: { status: "OFF", flowRate: 0, updatedAt: now } });
      if (lastStart) {
        await prisma.pumpLog.update({
          where: { id: lastStart.id },
          data: { stoppedAt: now, durationMinutes: Math.max(0, (now.getTime() - (lastStart.startedAt?.getTime() ?? now.getTime())) / 60000) },
        });
      }
      await prisma.pumpLog.create({
        data: {
          pumpId: pump.id, buildingId: pump.buildingId, action: "STOP",
          controlMode: pump.controlMode, reason: "Emergency stop activated",
          flowRate: 0, stoppedAt: now,
        },
      });
    }
  }
  response.json(updated);
}));

app.get("/api/buildings", asyncRoute(async (_request, response) => {
  const buildings = await prisma.building.findMany({ orderBy: { name: "asc" } });
  response.json(buildings);
}));

app.get("/api/buildings/:id", asyncRoute(async (request, response) => {
  if (!parseId(request.params.id, response)) return;
  const building = await prisma.building.findUnique({ where: { id: request.params.id } });
  if (!building) return response.status(404).json({ error: "Building not found" });
  const [tanks, pumps] = await Promise.all([
    prisma.waterTank.findMany({ where: { buildingId: building.id } }),
    prisma.pump.findMany({ where: { buildingId: building.id } }),
  ]);
  response.json({ ...building, tanks, pumps });
}));

app.get("/api/buildings/:id/usage", asyncRoute(async (request, response) => {
  if (!parseId(request.params.id, response)) return;
  const days = z.coerce.number().int().min(1).max(365).optional().default(30).parse(request.query.days);
  const from = dayStart();
  from.setUTCDate(from.getUTCDate() - days + 1);
  const usage = await prisma.dailyWaterUsage.findMany({
    where: { buildingId: request.params.id, date: { gte: from } },
    orderBy: { date: "asc" },
  });
  response.json(usage);
}));

app.get("/api/tanks", asyncRoute(async (_request, response) => {
  const tanks = await prisma.waterTank.findMany({ orderBy: { updatedAt: "desc" } });
  const buildings = await prisma.building.findMany();
  const names = new Map(buildings.map((building) => [building.id, building.name]));
  response.json(tanks.map((tank) => ({ ...tank, buildingName: names.get(tank.buildingId) ?? "Unknown" })));
}));

app.get("/api/tanks/:id", asyncRoute(async (request, response) => {
  if (!parseId(request.params.id, response)) return;
  const tank = await prisma.waterTank.findUnique({ where: { id: request.params.id } });
  if (!tank) return response.status(404).json({ error: "Tank not found" });
  response.json(tank);
}));

const tankInput = z.object({
  buildingId: z.string().regex(objectId),
  tankName: z.string().trim().min(1).max(100),
  capacityLiter: z.number().positive(),
  currentLevelLiter: z.number().nonnegative(),
  leakStatus: z.enum(["CLEAR", "DETECTED"]).optional(),
});

app.post("/api/tanks", asyncRoute(async (request, response) => {
  const data = tankInput.parse(request.body);
  if (data.currentLevelLiter > data.capacityLiter) {
    return response.status(400).json({ error: "Current level cannot exceed capacity" });
  }
  const building = await prisma.building.findUnique({ where: { id: data.buildingId } });
  if (!building) return response.status(400).json({ error: "Building not found" });
  const settings = await getSettings();
  const percent = (data.currentLevelLiter / data.capacityLiter) * 100;
  const tank = await prisma.waterTank.create({
    data: {
      ...data,
      currentLevelPercent: percent,
      status: levelStatus(percent, settings.criticalWaterThreshold, settings.lowWaterThreshold),
    },
  });
  response.status(201).json(tank);
}));

app.put("/api/tanks/:id", asyncRoute(async (request, response) => {
  if (!parseId(request.params.id, response)) return;
  const data = tankInput.partial().refine((value) => Object.keys(value).length > 0).parse(request.body);
  const existing = await prisma.waterTank.findUnique({ where: { id: request.params.id } });
  if (!existing) return response.status(404).json({ error: "Tank not found" });
  if (data.buildingId && !await prisma.building.findUnique({ where: { id: data.buildingId } })) {
    return response.status(400).json({ error: "Building not found" });
  }
  const capacity = data.capacityLiter ?? existing.capacityLiter;
  const liters = data.currentLevelLiter ?? existing.currentLevelLiter;
  if (liters > capacity) return response.status(400).json({ error: "Current level cannot exceed capacity" });
  const settings = await getSettings();
  const percent = (liters / capacity) * 100;
  const tank = await prisma.waterTank.update({
    where: { id: existing.id },
    data: {
      ...data,
      currentLevelPercent: percent,
      status: levelStatus(percent, settings.criticalWaterThreshold, settings.lowWaterThreshold),
    },
  });
  response.json(tank);
}));

app.get("/api/flow-meters", asyncRoute(async (_request, response) => {
  const [meters, buildings] = await Promise.all([
    prisma.flowMeter.findMany({ orderBy: { meterCode: "asc" } }),
    prisma.building.findMany(),
  ]);
  const buildingNames = new Map(buildings.map((building) => [building.id, building.name]));
  response.json(meters.map((meter) => ({
    ...meter,
    buildingName: buildingNames.get(meter.buildingId) ?? "Unknown",
  })));
}));

app.post("/api/flow-meters", asyncRoute(async (request, response) => {
  const data = z.object({
    buildingId: z.string().regex(objectId),
    meterCode: z.string().trim().min(1).max(50),
    meterName: z.string().trim().min(1).max(100),
  }).parse(request.body);
  const building = await prisma.building.findUnique({ where: { id: data.buildingId } });
  if (!building) return response.status(400).json({ error: "Building not found" });
  const meter = await prisma.flowMeter.create({ data });
  response.status(201).json(meter);
}));

app.get("/api/pumps", asyncRoute(async (_request, response) => {
  const pumps = await prisma.pump.findMany({ orderBy: { pumpCode: "asc" } });
  const buildings = await prisma.building.findMany();
  const names = new Map(buildings.map((building) => [building.id, building.name]));
  response.json(pumps.map((pump) => ({ ...pump, buildingName: names.get(pump.buildingId) ?? "Unknown" })));
}));

app.get("/api/pumps/:id", asyncRoute(async (request, response) => {
  if (!parseId(request.params.id, response)) return;
  const pump = await prisma.pump.findUnique({ where: { id: request.params.id } });
  if (!pump) return response.status(404).json({ error: "Pump not found" });
  response.json(pump);
}));

const pumpCommand = z.object({ reason: z.string().trim().min(3).max(200) });

app.post("/api/pumps/:id/start", asyncRoute(async (request, response) => {
  if (!parseId(request.params.id, response)) return;
  const { reason } = pumpCommand.parse(request.body);
  const pump = await prisma.pump.findUnique({ where: { id: request.params.id } });
  if (!pump) return response.status(404).json({ error: "Pump not found" });
  const settings = await getSettings();
  if (!pump.isOnline) return response.status(409).json({ error: "Pump is offline" });
  if (pump.status === "FAULT") return response.status(409).json({ error: "Faulted pump cannot be started" });
  if (settings.emergencyStop) return response.status(409).json({ error: "Emergency stop is active" });
  if (pump.controlMode !== "MANUAL") return response.status(409).json({ error: "Switch pump to manual mode before starting it" });
  if (pump.status === "ON") return response.status(409).json({ error: "Pump is already running" });
  const now = new Date();
  const updated = await prisma.pump.update({
    where: { id: pump.id },
    data: { status: "ON", updatedAt: now, flowRate: pump.flowRate || 85 },
  });
  await prisma.pumpLog.create({
    data: {
      pumpId: pump.id,
      buildingId: pump.buildingId,
      action: "START",
      controlMode: pump.controlMode,
      reason,
      flowRate: updated.flowRate,
      startedAt: now,
    },
  });
  response.json(updated);
}));

app.post("/api/pumps/:id/stop", asyncRoute(async (request, response) => {
  if (!parseId(request.params.id, response)) return;
  const { reason } = pumpCommand.parse(request.body);
  const pump = await prisma.pump.findUnique({ where: { id: request.params.id } });
  if (!pump) return response.status(404).json({ error: "Pump not found" });
  if (!pump.isOnline) return response.status(409).json({ error: "Pump is offline" });
  if (pump.controlMode !== "MANUAL") return response.status(409).json({ error: "Switch pump to manual mode before stopping it" });
  if (pump.status !== "ON") return response.status(409).json({ error: "Pump is not running" });
  const now = new Date();
  const lastStart = await prisma.pumpLog.findFirst({
    where: { pumpId: pump.id, action: "START", stoppedAt: null },
    orderBy: { startedAt: "desc" },
  });
  const updated = await prisma.pump.update({
    where: { id: pump.id },
    data: { status: "OFF", flowRate: 0, updatedAt: now },
  });
  if (lastStart) {
    await prisma.pumpLog.update({
      where: { id: lastStart.id },
      data: { stoppedAt: now, durationMinutes: Math.max(0, (now.getTime() - (lastStart.startedAt?.getTime() ?? now.getTime())) / 60000) },
    });
  }
  await prisma.pumpLog.create({
    data: {
      pumpId: pump.id,
      buildingId: pump.buildingId,
      action: "STOP",
      controlMode: pump.controlMode,
      reason,
      flowRate: 0,
      stoppedAt: now,
    },
  });
  response.json(updated);
}));

app.put("/api/pumps/:id/mode", asyncRoute(async (request, response) => {
  if (!parseId(request.params.id, response)) return;
  const { controlMode } = z.object({ controlMode: z.enum(["AUTO", "MANUAL"]) }).parse(request.body);
  const pump = await prisma.pump.findUnique({ where: { id: request.params.id } });
  if (!pump) return response.status(404).json({ error: "Pump not found" });
  response.json(await prisma.pump.update({
    where: { id: pump.id },
    data: { controlMode, updatedAt: new Date() },
  }));
}));

app.post("/api/sensors/readings", authenticateDevice, asyncRoute(async (request, response) => {
  const data = z.object({
    tankId: z.string().regex(objectId),
    waterLevel: z.number().nonnegative(),
    flowRate: z.number().nonnegative().default(0),
    temperature: z.number().optional(),
    leakDetected: z.boolean().default(false),
    recordedAt: z.coerce.date().optional(),
    source: z.enum(["DEVICE", "MOCK"]).default("DEVICE"),
  }).parse(request.body);
  const tank = await prisma.waterTank.findUnique({ where: { id: data.tankId } });
  if (!tank) return response.status(400).json({ error: "Tank not found" });
  if (data.waterLevel > tank.capacityLiter) return response.status(400).json({ error: "Water level exceeds tank capacity" });
  const recordedAt = data.recordedAt ?? new Date();
  const percent = (data.waterLevel / tank.capacityLiter) * 100;
  const settings = await getSettings();
  const latest = await prisma.sensorReading.findFirst({
    where: { tankId: tank.id },
    orderBy: { recordedAt: "desc" },
  });
  if (latest && recordedAt <= latest.recordedAt) {
    return response.status(409).json({ error: "Sensor reading must be newer than the latest reading" });
  }
  const previous = await prisma.sensorReading.findFirst({
    where: { tankId: tank.id, flowRate: { not: null } },
    orderBy: { recordedAt: "desc" },
  });
  const reading = await prisma.sensorReading.create({
    data: {
      tankId: tank.id,
      waterLevel: data.waterLevel,
      waterLevelPercent: percent,
      flowRate: data.flowRate,
      temperature: data.temperature,
      leakDetected: data.leakDetected,
      source: data.source,
      recordedAt,
    },
  });
  await prisma.waterTank.update({
    where: { id: tank.id },
    data: {
      currentLevelLiter: data.waterLevel,
      currentLevelPercent: percent,
      status: levelStatus(percent, settings.criticalWaterThreshold, settings.lowWaterThreshold),
      leakStatus: data.leakDetected ? "DETECTED" : "CLEAR",
    },
  });
  await evaluateAutomaticPumps(tank.buildingId, percent, settings);
  if (previous && previous.flowRate !== null) {
    const averageFlowRate = (previous.flowRate + data.flowRate) / 2;
    const price = settings.waterPricePerM3 / 1000;
    const buildingId = tank.buildingId;
    const dailySegments = splitUsageByUtcDay(previous.recordedAt, recordedAt, averageFlowRate);
    for (const segment of dailySegments) {
      await prisma.dailyWaterUsage.upsert({
        where: { date_buildingId: { date: segment.date, buildingId } },
        create: {
          date: segment.date,
          buildingId,
          totalUsageLiter: segment.liters,
          averageFlowRate,
          peakFlowRate: Math.max(previous.flowRate, data.flowRate),
          estimatedCost: segment.liters * price,
        },
        update: {
          totalUsageLiter: { increment: segment.liters },
          estimatedCost: { increment: segment.liters * price },
          peakFlowRate: Math.max(previous.flowRate, data.flowRate),
          averageFlowRate,
        },
      });
    }
    const billMonths = Array.from(new Map(dailySegments.map((segment) => {
      const monthDate = new Date(Date.UTC(segment.date.getUTCFullYear(), segment.date.getUTCMonth(), 1));
      return [`${monthDate.getUTCFullYear()}-${monthDate.getUTCMonth()}`, segment.date];
    })).values());
    for (const billMonth of billMonths) await refreshMonthlyBill(billMonth, settings.waterPricePerM3);
  }
  if (data.leakDetected || percent < settings.lowWaterThreshold) {
    const alertType = data.leakDetected ? "WATER_LEAK" : "TANK_LEVEL_LOW";
    const existingAlert = await prisma.alert.findFirst({
      where: { tankId: tank.id, alertType, isAcknowledged: false },
    });
    if (!existingAlert) {
      await prisma.alert.create({
        data: {
          buildingId: tank.buildingId,
          tankId: tank.id,
          alertType,
          severity: data.leakDetected || percent < settings.criticalWaterThreshold ? "CRITICAL" : "WARNING",
          message: data.leakDetected ? `Water leak detected at ${tank.tankName}` : `Tank level critical at ${tank.tankName}`,
        },
      });
    }
  }
  response.status(201).json(reading);
}));

app.post("/api/device-telemetry", authenticateDevice, asyncRoute(async (request, response) => {
  const packet = deviceTelemetrySchema.parse(request.body);
  const recordedAt = packet.recordedAt ?? new Date();
  const [tankRecords, meterRecords, pumpRecords] = await Promise.all([
    Promise.all(packet.tanks.map((sample) => prisma.waterTank.findUnique({ where: { id: sample.tankId } }))),
    Promise.all(packet.flowMeters.map((sample) => prisma.flowMeter.findUnique({ where: { meterCode: sample.meterCode } }))),
    Promise.all(packet.pumps.map((sample) => prisma.pump.findUnique({ where: { pumpCode: sample.pumpCode } }))),
  ]);
  const missingTank = tankRecords.findIndex((tank) => !tank);
  if (missingTank >= 0) {
    return response.status(404).json({ error: `Tank not found: ${packet.tanks[missingTank].tankId}` });
  }
  const missingMeter = meterRecords.findIndex((meter) => !meter);
  if (missingMeter >= 0) {
    return response.status(404).json({ error: `Flow meter not found: ${packet.flowMeters[missingMeter].meterCode}` });
  }
  const missingPump = pumpRecords.findIndex((pump) => !pump);
  if (missingPump >= 0) {
    return response.status(404).json({ error: `Pump not found: ${packet.pumps[missingPump].pumpCode}` });
  }
  const pumpContext = await Promise.all(packet.pumps.map(async (sample, index) => {
    const pump = pumpRecords[index]!;
    const latest = await prisma.pumpReading.findFirst({
      where: { pumpId: pump.id, deviceId: packet.deviceId },
      orderBy: { recordedAt: "desc" },
    });
    return { sample, pump, error: latest && recordedAt <= latest.recordedAt
      ? "Reading time must be newer than the latest reading from this device"
      : null };
  }));
  const invalidPump = pumpContext.find((context) => context.error);
  if (invalidPump) {
    return response.status(409).json({ error: invalidPump.error, pumpCode: invalidPump.sample.pumpCode });
  }
  const meterContext = await Promise.all(packet.flowMeters.map(async (sample, index) => {
    const meter = meterRecords[index]!;
    const latest = await prisma.flowReading.findFirst({
      where: { flowMeterId: meter.id, deviceId: packet.deviceId },
      orderBy: { recordedAt: "desc" },
    });
    if (latest && recordedAt <= latest.recordedAt) {
      return { sample, meter, latest, error: "Reading time must be newer than the latest reading from this device" };
    }
    if (
      sample.totalizerLiter !== undefined &&
      latest?.totalizerLiter !== null &&
      latest?.totalizerLiter !== undefined &&
      sample.totalizerLiter < latest.totalizerLiter
    ) {
      return { sample, meter, latest, error: "Flow meter totalizer decreased; check for a meter reset before sending another reading" };
    }
    return { sample, meter, latest, error: null };
  }));
  const invalidMeter = meterContext.find((context) => context.error);
  if (invalidMeter) {
    return response.status(409).json({ error: invalidMeter.error, meterCode: invalidMeter.sample.meterCode });
  }

  const settings = await getSettings();
  const tankContext = await Promise.all(packet.tanks.map(async (sample, index) => {
    const tank = tankRecords[index]!;
    if (sample.waterLevelLiter !== undefined && sample.waterLevelLiter > tank.capacityLiter) {
      return { sample, tank, error: "Water level exceeds tank capacity" };
    }
    const latest = await prisma.sensorReading.findFirst({
      where: { tankId: tank.id, deviceId: packet.deviceId },
      orderBy: { recordedAt: "desc" },
    });
    if (latest && recordedAt <= latest.recordedAt) {
      return { sample, tank, error: "Reading time must be newer than the latest reading from this device" };
    }
    return { sample, tank, error: null };
  }));
  const invalidTank = tankContext.find((context) => context.error);
  if (invalidTank) return response.status(409).json({ error: invalidTank.error, tankId: invalidTank.sample.tankId });

  for (const context of tankContext) {
    const { sample, tank } = context;
    const percent = sample.waterLevelLiter === undefined
      ? undefined
      : sample.waterLevelLiter / tank.capacityLiter * 100;
    await prisma.sensorReading.create({
      data: {
        tankId: tank.id,
        deviceId: packet.deviceId,
        waterLevel: sample.waterLevelLiter,
        waterLevelPercent: percent,
        pressureKpa: sample.pressureKpa,
        lowLevelSwitch: sample.lowLevelSwitch,
        highLevelSwitch: sample.highLevelSwitch,
        temperature: sample.temperature,
        leakDetected: sample.leakDetected,
        source: "DEVICE",
        recordedAt,
      },
    });

    await prisma.waterTank.update({
      where: { id: tank.id },
      data: {
        ...(sample.waterLevelLiter !== undefined && percent !== undefined ? {
          currentLevelLiter: sample.waterLevelLiter,
          currentLevelPercent: percent,
          status: levelStatus(percent, settings.criticalWaterThreshold, settings.lowWaterThreshold),
        } : {}),
        ...(sample.pressureKpa !== undefined ? { pressureKpa: sample.pressureKpa } : {}),
        ...(sample.lowLevelSwitch !== undefined ? { lowLevelSwitch: sample.lowLevelSwitch } : {}),
        ...(sample.highLevelSwitch !== undefined ? { highLevelSwitch: sample.highLevelSwitch } : {}),
        ...(sample.leakDetected !== undefined ? { leakStatus: sample.leakDetected ? "DETECTED" : "CLEAR" } : {}),
        lastSeenAt: recordedAt,
      },
    });

    const tankIsLow = sample.lowLevelSwitch === true ||
      (percent !== undefined && percent < settings.lowWaterThreshold);
    if (sample.leakDetected === true || tankIsLow) {
      const alertType = sample.leakDetected === true ? "WATER_LEAK" : "TANK_LEVEL_LOW";
      const existing = await prisma.alert.findFirst({
        where: { tankId: tank.id, alertType, isAcknowledged: false },
      });
      if (!existing) {
        await prisma.alert.create({
          data: {
            buildingId: tank.buildingId,
            tankId: tank.id,
            alertType,
            severity: sample.leakDetected === true ||
              (percent !== undefined && percent < settings.criticalWaterThreshold) ? "CRITICAL" : "WARNING",
            message: sample.leakDetected === true
              ? `Water leak detected by ${packet.deviceId} at ${tank.tankName}`
              : `Low level switch or level threshold triggered at ${tank.tankName}`,
          },
        });
      }
    }
  }

  for (const { sample, meter, latest: previousFlow } of meterContext) {
    let averageFlowRate: number | undefined;
    if (previousFlow && sample.totalizerLiter !== undefined && previousFlow.totalizerLiter !== null) {
      averageFlowRate = calculateTotalizerFlowRate(
        previousFlow.totalizerLiter,
        sample.totalizerLiter,
        recordedAt.getTime() - previousFlow.recordedAt.getTime(),
      );
    } else if (previousFlow && sample.flowRateLpm !== undefined && previousFlow.flowRateLpm !== null) {
      averageFlowRate = (previousFlow.flowRateLpm + sample.flowRateLpm) / 2;
    }
    await prisma.flowReading.create({
      data: {
        flowMeterId: meter.id,
        deviceId: packet.deviceId,
        flowRateLpm: sample.flowRateLpm ?? averageFlowRate,
        totalizerLiter: sample.totalizerLiter,
        source: "DEVICE",
        recordedAt,
      },
    });
    await prisma.flowMeter.update({
      where: { id: meter.id },
      data: {
        flowRateLpm: sample.flowRateLpm ?? averageFlowRate ?? meter.flowRateLpm,
        ...(sample.totalizerLiter !== undefined ? { totalizerLiter: sample.totalizerLiter } : {}),
        isOnline: true,
        lastSeenAt: recordedAt,
      },
    });
    if (previousFlow && averageFlowRate !== undefined) {
      await recordUsageInterval(
        meter.buildingId,
        previousFlow.recordedAt,
        recordedAt,
        averageFlowRate,
        Math.max(previousFlow.flowRateLpm ?? 0, sample.flowRateLpm ?? averageFlowRate),
        settings.waterPricePerM3,
      );
    }
  }

  for (const { sample, pump } of pumpContext) {
    const nextStatus = sample.fault === true
      ? "FAULT"
      : sample.running !== undefined
        ? sample.running ? "ON" : "OFF"
        : sample.fault === false && pump.status === "FAULT"
          ? "OFF"
          : pump.status;
    const statusChanged = nextStatus !== pump.status;
    const nextFlowRate = sample.flowRateLpm ??
      (nextStatus === "OFF" || nextStatus === "FAULT" ? 0 : pump.flowRate);
    const updatedPump = await prisma.pump.update({
      where: { id: pump.id },
      data: {
        status: nextStatus,
        flowRate: nextFlowRate,
        ...(sample.currentA !== undefined ? { currentA: sample.currentA } : {}),
        ...(sample.voltageV !== undefined ? { voltageV: sample.voltageV } : {}),
        ...(sample.powerFactor !== undefined ? { powerFactor: sample.powerFactor } : {}),
        ...(sample.activePowerKw !== undefined ? { activePowerKw: sample.activePowerKw } : {}),
        ...(sample.energyKwh !== undefined ? { energyKwh: sample.energyKwh } : {}),
        ...(sample.faultCode !== undefined ? { faultCode: sample.faultCode } : sample.fault === false ? { faultCode: null } : {}),
        isOnline: true,
        lastSeenAt: recordedAt,
      },
    });
    await prisma.pumpReading.create({
      data: {
        pumpId: pump.id,
        deviceId: packet.deviceId,
        status: nextStatus,
        flowRate: sample.flowRateLpm,
        currentA: sample.currentA,
        voltageV: sample.voltageV,
        powerFactor: sample.powerFactor,
        activePowerKw: sample.activePowerKw,
        energyKwh: sample.energyKwh,
        faultCode: sample.faultCode,
        overcurrent: sample.overcurrentDetected,
        source: "DEVICE",
        recordedAt,
      },
    });

    const reason = sample.faultCode ?? `Device status reported ${nextStatus}`;
    if (statusChanged && pump.status === "ON" && nextStatus !== "ON") {
      const openStart = await prisma.pumpLog.findFirst({
        where: { pumpId: pump.id, action: "START", stoppedAt: null },
        orderBy: { startedAt: "desc" },
      });
      if (openStart) {
        await prisma.pumpLog.update({
          where: { id: openStart.id },
          data: {
            stoppedAt: recordedAt,
            durationMinutes: Math.max(0, (recordedAt.getTime() - (openStart.startedAt?.getTime() ?? recordedAt.getTime())) / 60000),
          },
        });
      }
    }
    if (statusChanged) {
      await prisma.pumpLog.create({
        data: {
          pumpId: pump.id,
          buildingId: pump.buildingId,
          action: nextStatus === "FAULT" ? "FAULT" : nextStatus === "ON" ? "START" : "STOP",
          controlMode: pump.controlMode,
          reason,
          flowRate: updatedPump.flowRate,
          ...(nextStatus === "ON" ? { startedAt: recordedAt } : { stoppedAt: recordedAt }),
        },
      });
    }

    const alertTypes = [
      ...(sample.fault === true ? ["PUMP_FAULT"] : []),
      ...(sample.overcurrentDetected === true ? ["PUMP_OVERCURRENT"] : []),
    ];
    for (const alertType of alertTypes) {
      const existing = await prisma.alert.findFirst({
        where: { pumpId: pump.id, alertType, isAcknowledged: false },
      });
      if (!existing) {
        await prisma.alert.create({
          data: {
            buildingId: pump.buildingId,
            pumpId: pump.id,
            alertType,
            severity: "CRITICAL",
            message: `${alertType === "PUMP_OVERCURRENT" ? "Overcurrent detected" : "Pump fault"} on ${pump.pumpCode}${sample.faultCode ? `: ${sample.faultCode}` : ""}`,
          },
        });
      }
    }
  }

  response.status(202).json({
    accepted: true,
    deviceId: packet.deviceId,
    recordedAt,
    tanksReceived: packet.tanks.length,
    flowMetersReceived: packet.flowMeters.length,
    pumpsReceived: packet.pumps.length,
  });
}));

app.get("/api/dashboard/overview", asyncRoute(async (_request, response) => {
  const today = dayStart();
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const month = monthStart();
  const previousMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1));
  const [tanks, pumps, flowMeters, buildings, todayUsage, yesterdayUsage, monthUsage, previousMonthUsage, alerts] = await Promise.all([
    prisma.waterTank.findMany(),
    prisma.pump.findMany(),
    prisma.flowMeter.findMany(),
    prisma.building.findMany(),
    prisma.dailyWaterUsage.findMany({ where: { date: today } }),
    prisma.dailyWaterUsage.findMany({ where: { date: yesterday } }),
    prisma.dailyWaterUsage.findMany({ where: { date: { gte: month } } }),
    prisma.dailyWaterUsage.findMany({ where: { date: { gte: previousMonth, lt: month } } }),
    prisma.alert.count({ where: { isAcknowledged: false } }),
  ]);
  const sum = (rows: { totalUsageLiter: number }[]) => rows.reduce((total, row) => total + row.totalUsageLiter, 0);
  const totalCapacityLiter = tanks.reduce((total, tank) => total + tank.capacityLiter, 0);
  const currentStorageLiter = tanks.reduce((total, tank) => total + tank.currentLevelLiter, 0);
  const activePumps = pumps.filter((pump) => pump.status === "ON").length;
  const todayLiters = sum(todayUsage);
  const settings = await getSettings();
  const monthCost = sum(monthUsage) * settings.waterPricePerM3 / 1000;
  const previousMonthCost = sum(previousMonthUsage) * settings.waterPricePerM3 / 1000;
  response.json({
    totalStorageLiter: currentStorageLiter,
    totalCapacityLiter,
    storagePercent: totalCapacityLiter ? (currentStorageLiter / totalCapacityLiter) * 100 : 0,
    currentUsageLpm: flowMeters.reduce((total, meter) => total + meter.flowRateLpm, 0),
    hourlyUsageLiter: flowMeters.reduce((total, meter) => total + meter.flowRateLpm * 60, 0),
    estimatedDailyCost: todayLiters * settings.waterPricePerM3 / 1000,
    monthCost,
    previousMonthCost,
    todayUsageLiter: todayLiters,
    yesterdayUsageLiter: sum(yesterdayUsage),
    weekUsageLiter: sum(await prisma.dailyWaterUsage.findMany({ where: { date: { gte: new Date(today.getTime() - 6 * 86400000) } } })),
    monthUsageLiter: sum(monthUsage),
    activePumps,
    totalPumps: pumps.length,
    normalTanks: tanks.filter((tank) => tank.status === "NORMAL" && tank.leakStatus === "CLEAR").length,
    problemTanks: tanks.filter((tank) => tank.status !== "NORMAL" || tank.leakStatus === "DETECTED").length,
    systemStatus: pumps.every((pump) => pump.isOnline) ? "ONLINE" : "DEGRADED",
    unacknowledgedAlerts: alerts,
    buildings: buildings.length,
  });
}));

app.get("/api/dashboard/water-usage", asyncRoute(async (request, response) => {
  const range = z.enum(["24h", "7d", "30d", "12m"]).optional().default("7d").parse(request.query.range);
  const now = new Date();
  const from = new Date(now);
  if (range === "24h") from.setHours(from.getHours() - 24);
  else if (range === "7d") from.setDate(from.getDate() - 6);
  else if (range === "30d") from.setDate(from.getDate() - 29);
  else from.setMonth(from.getMonth() - 11, 1);
  const tanks = await prisma.waterTank.findMany();
  const storage = tanks.reduce((total, tank) => total + tank.currentLevelPercent, 0) / Math.max(1, tanks.length);
  let data;
  if (range === "24h") {
    const [flowReadings, sensorReadings] = await Promise.all([
      prisma.flowReading.findMany({
        where: { recordedAt: { gte: from } },
        orderBy: { recordedAt: "asc" },
      }),
      prisma.sensorReading.findMany({
        where: { recordedAt: { gte: from } },
        orderBy: { recordedAt: "asc" },
      }),
    ]);
    const readings = [
      ...flowReadings.map((reading) => ({
        streamId: `flow:${reading.flowMeterId}:${reading.deviceId ?? "legacy"}`,
        recordedAt: reading.recordedAt,
        flowRate: reading.flowRateLpm,
        totalizerLiter: reading.totalizerLiter,
        waterLevelPercent: null as number | null,
        source: reading.source,
      })),
      ...sensorReadings.map((reading) => ({
        streamId: `tank:${reading.tankId}:${reading.deviceId ?? "legacy"}`,
        recordedAt: reading.recordedAt,
        flowRate: reading.flowRate,
        totalizerLiter: reading.flowTotalizerLiter,
        waterLevelPercent: reading.waterLevelPercent,
        source: reading.source,
      })),
    ].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
    const previousByStream = new Map<string, (typeof readings)[number]>();
    const hourly = new Map<string, { usage: number; storageTotal: number; storageCount: number; source: string }>();
    for (const reading of readings) {
      const previous = previousByStream.get(reading.streamId);
      previousByStream.set(reading.streamId, reading);
      const key = new Date(reading.recordedAt);
      key.setMinutes(0, 0, 0);
      const label = key.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const point = hourly.get(label) ?? { usage: 0, storageTotal: 0, storageCount: 0, source: "DEVICE" };
      if (previous && reading.recordedAt > previous.recordedAt &&
        previous.totalizerLiter !== null && reading.totalizerLiter !== null) {
        point.usage += (reading.totalizerLiter - previous.totalizerLiter);
      } else if (previous && reading.recordedAt > previous.recordedAt &&
        previous.flowRate !== null && reading.flowRate !== null) {
        const intervalMinutes = (reading.recordedAt.getTime() - previous.recordedAt.getTime()) / 60000;
        point.usage += ((previous.flowRate + reading.flowRate) / 2) * intervalMinutes;
      }
      if (reading.waterLevelPercent !== null) {
        point.storageTotal += reading.waterLevelPercent;
        point.storageCount += 1;
      }
      if (reading.source === "MOCK") point.source = "MOCK";
      hourly.set(label, point);
    }
    data = Array.from(hourly, ([label, point]) => ({
      label,
      usage: point.usage,
      storage: point.storageCount ? point.storageTotal / point.storageCount : storage,
      source: point.source,
    }));
  } else if (range === "12m") {
    const bills = await prisma.monthlyWaterBill.findMany({
      where: {
        OR: Array.from({ length: 12 }, (_, index) => {
          const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
          return { year: date.getFullYear(), month: date.getMonth() + 1 };
        }),
      },
      orderBy: [{ year: "asc" }, { month: "asc" }],
    });
    data = bills.map((bill) => ({
      label: new Date(Date.UTC(bill.year, bill.month - 1, 1)).toLocaleDateString("en-US", { month: "short" }),
      usage: bill.totalUsageLiter,
      storage,
      source: "DATABASE",
    }));
  } else {
    const daily = await prisma.dailyWaterUsage.findMany({
      where: { date: { gte: dayStart(from) } },
      orderBy: { date: "asc" },
    });
    const byDate = new Map<string, number>();
    for (const row of daily) {
      const key = row.date.toISOString().slice(0, 10);
      byDate.set(key, (byDate.get(key) ?? 0) + row.totalUsageLiter);
    }
    data = Array.from(byDate, ([key, usage]) => ({
      label: new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      usage,
      storage,
      source: "DATABASE",
    }));
  }
  response.json({ range, data });
}));

app.get("/api/dashboard/water-cost", asyncRoute(async (_request, response) => {
  const bills = await prisma.monthlyWaterBill.findMany({ orderBy: [{ year: "asc" }, { month: "asc" }] });
  response.json(bills);
}));

app.get("/api/dashboard/recent-events", asyncRoute(async (request, response) => {
  const limit = z.coerce.number().int().min(1).max(100).optional().default(12).parse(request.query.limit);
  const [alerts, logs, buildings, pumps, tanks] = await Promise.all([
    prisma.alert.findMany({ orderBy: { createdAt: "desc" }, take: limit }),
    prisma.pumpLog.findMany({ orderBy: { createdAt: "desc" }, take: limit }),
    prisma.building.findMany(),
    prisma.pump.findMany(),
    prisma.waterTank.findMany(),
  ]);
  const buildingNames = new Map(buildings.map((item) => [item.id, item.name]));
  const pumpNames = new Map(pumps.map((item) => [item.id, item.pumpCode]));
  const events = [
    ...alerts.map((item) => ({
      id: item.id, kind: "alert", title: item.alertType.replaceAll("_", " "),
      detail: item.message, severity: item.severity, createdAt: item.createdAt,
      buildingName: item.buildingId ? buildingNames.get(item.buildingId) : "Campus",
    })),
    ...logs.map((item) => ({
      id: item.id, kind: "pump", title: `Pump ${item.action.toLowerCase()}`,
      detail: `${pumpNames.get(item.pumpId) ?? "Pump"} · ${item.reason}`,
      severity: item.action === "FAULT" ? "CRITICAL" : "INFO",
      createdAt: item.createdAt, buildingName: buildingNames.get(item.buildingId) ?? "Campus",
    })),
    ...tanks.filter((tank) => tank.status !== "NORMAL" || tank.leakStatus === "DETECTED").map((item) => ({
      id: item.id, kind: "tank", title: item.leakStatus === "DETECTED" ? "Water leak detected" : "Tank level low",
      detail: `${item.tankName} · ${Math.round(item.currentLevelPercent)}%`,
      severity: item.status, createdAt: item.updatedAt, buildingName: buildingNames.get(item.buildingId) ?? "Campus",
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  response.json(events);
}));

app.get("/api/usage/daily", asyncRoute(async (request, response) => {
  const days = z.coerce.number().int().min(1).max(365).optional().default(30).parse(request.query.days);
  const from = dayStart();
  from.setUTCDate(from.getUTCDate() - days + 1);
  response.json(await prisma.dailyWaterUsage.findMany({ where: { date: { gte: from } }, orderBy: { date: "asc" } }));
}));

app.get("/api/usage/monthly", asyncRoute(async (_request, response) => {
  response.json(await prisma.monthlyWaterBill.findMany({ orderBy: [{ year: "desc" }, { month: "desc" }] }));
}));

app.get("/api/usage/statistics", asyncRoute(async (_request, response) => {
  const today = dayStart();
  const month = monthStart();
  const weekStart = new Date(today.getTime() - 6 * 86400000);
  const usage = await prisma.dailyWaterUsage.findMany({ where: { date: { gte: month } } });
  const buildings = await prisma.building.findMany();
  const byBuilding = new Map<string, number>();
  for (const row of usage) byBuilding.set(row.buildingId, (byBuilding.get(row.buildingId) ?? 0) + row.totalUsageLiter);
  const leaders = buildings.map((building) => ({ buildingName: building.name, usageLiter: byBuilding.get(building.id) ?? 0 }))
    .sort((a, b) => b.usageLiter - a.usageLiter);
  const sum = (rows: { totalUsageLiter: number }[]) => rows.reduce((total, row) => total + row.totalUsageLiter, 0);
  const [allUsage, recentTankReadings, recentFlowReadings] = await Promise.all([
    prisma.dailyWaterUsage.findMany({ where: { date: { gte: weekStart } } }),
    prisma.sensorReading.findMany({ where: { recordedAt: { gte: weekStart }, flowRate: { not: null } } }),
    prisma.flowReading.findMany({ where: { recordedAt: { gte: weekStart }, flowRateLpm: { not: null } } }),
  ]);
  const peakFlow = [
    ...recentTankReadings.flatMap((reading) => reading.flowRate === null ? [] : [{ flowRate: reading.flowRate, recordedAt: reading.recordedAt }]),
    ...recentFlowReadings.flatMap((reading) => reading.flowRateLpm === null ? [] : [{ flowRate: reading.flowRateLpm, recordedAt: reading.recordedAt }]),
  ].reduce<{ flowRate: number; recordedAt: Date } | null>(
    (peak, reading) => !peak || reading.flowRate > peak.flowRate ? reading : peak,
    null,
  );
  const settings = await getSettings();
  response.json({
    todayLiter: sum(await prisma.dailyWaterUsage.findMany({ where: { date: today } })),
    weekLiter: sum(allUsage),
    monthLiter: sum(usage),
    averageDailyLiter: sum(usage) / Math.max(1, new Set(usage.map((row) => row.date.toISOString())).size),
    peakUsageTime: peakFlow?.recordedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) ?? null,
    topBuilding: leaders[0] ?? null,
    buildings: leaders.map((building) => ({
      ...building,
      estimatedCost: building.usageLiter * settings.waterPricePerM3 / 1000,
    })),
  });
}));

app.get("/api/pump-logs", asyncRoute(async (request, response) => {
  const days = z.coerce.number().int().min(1).max(30).optional().default(1).parse(request.query.days);
  const from = new Date(Date.now() - days * 86400000);
  const [logs, buildings, pumps] = await Promise.all([
    prisma.pumpLog.findMany({ where: { createdAt: { gte: from } }, orderBy: { createdAt: "desc" }, take: 500 }),
    prisma.building.findMany(),
    prisma.pump.findMany(),
  ]);
  const buildingNames = new Map(buildings.map((item) => [item.id, item.name]));
  const pumpNames = new Map(pumps.map((item) => [item.id, item.pumpCode]));
  response.json(logs.map((log) => ({
    ...log,
    pumpCode: pumpNames.get(log.pumpId) ?? "Unknown",
    buildingName: buildingNames.get(log.buildingId) ?? "Unknown",
  })));
}));

app.get("/api/alerts", asyncRoute(async (request, response) => {
  const alerts = await prisma.alert.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  response.json(alerts);
}));

app.put("/api/alerts/:id/acknowledge", asyncRoute(async (request, response) => {
  if (!parseId(request.params.id, response)) return;
  const alert = await prisma.alert.update({
    where: { id: request.params.id },
    data: { isAcknowledged: true },
  });
  response.json(alert);
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    return response.status(400).json({ error: "Validation failed", details: error.flatten() });
  }
  if (error instanceof SyntaxError) {
    return response.status(400).json({ error: "Malformed JSON request body" });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
    return response.status(404).json({ error: "Record not found" });
  }
  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

const server = app.listen(port, () => {
  console.log(`Water management API listening on http://localhost:${port}`);
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
