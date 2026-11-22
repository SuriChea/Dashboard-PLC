import "dotenv/config";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { splitUsageByUtcDay } from "./waterUsage";

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

app.post("/api/sensors/readings", asyncRoute(async (request, response) => {
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
  const previous = latest;
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
  if (previous) {
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

app.get("/api/dashboard/overview", asyncRoute(async (_request, response) => {
  const today = dayStart();
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const month = monthStart();
  const previousMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1));
  const [tanks, pumps, buildings, todayUsage, yesterdayUsage, monthUsage, previousMonthUsage, alerts] = await Promise.all([
    prisma.waterTank.findMany(),
    prisma.pump.findMany(),
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
    currentUsageLpm: pumps.reduce((total, pump) => total + (pump.status === "ON" ? pump.flowRate : 0), 0),
    hourlyUsageLiter: pumps.filter((pump) => pump.status === "ON").reduce((total, pump) => total + pump.flowRate * 60, 0),
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
    const readings = await prisma.sensorReading.findMany({
      where: { recordedAt: { gte: from } },
      orderBy: { recordedAt: "asc" },
    });
    const previousByTank = new Map<string, (typeof readings)[number]>();
    const hourly = new Map<string, { usage: number; storageTotal: number; count: number; source: string }>();
    for (const reading of readings) {
      const previous = previousByTank.get(reading.tankId);
      previousByTank.set(reading.tankId, reading);
      if (!previous || reading.recordedAt <= previous.recordedAt) continue;
      const key = new Date(reading.recordedAt);
      key.setMinutes(0, 0, 0);
      const label = key.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const intervalMinutes = (reading.recordedAt.getTime() - previous.recordedAt.getTime()) / 60000;
      const point = hourly.get(label) ?? { usage: 0, storageTotal: 0, count: 0, source: "DEVICE" };
      point.usage += ((previous.flowRate + reading.flowRate) / 2) * intervalMinutes;
      point.storageTotal += reading.waterLevelPercent;
      point.count += 1;
      if (reading.source === "MOCK") point.source = "MOCK";
      hourly.set(label, point);
    }
    data = Array.from(hourly, ([label, point]) => ({
      label,
      usage: point.usage,
      storage: point.storageTotal / point.count,
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
  const [allUsage, recentReadings] = await Promise.all([
    prisma.dailyWaterUsage.findMany({ where: { date: { gte: weekStart } } }),
    prisma.sensorReading.findMany({ where: { recordedAt: { gte: weekStart } } }),
  ]);
  const peakReading = recentReadings.reduce<(typeof recentReadings)[number] | null>(
    (peak, reading) => !peak || reading.flowRate > peak.flowRate ? reading : peak,
    null,
  );
  const settings = await getSettings();
  response.json({
    todayLiter: sum(await prisma.dailyWaterUsage.findMany({ where: { date: today } })),
    weekLiter: sum(allUsage),
    monthLiter: sum(usage),
    averageDailyLiter: sum(usage) / Math.max(1, new Set(usage.map((row) => row.date.toISOString())).size),
    peakUsageTime: peakReading?.recordedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) ?? null,
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
