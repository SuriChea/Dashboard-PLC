import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const fixedIds = {
  buildings: [
    "64a000000000000000000001",
    "64a000000000000000000002",
    "64a000000000000000000003",
    "64a000000000000000000004",
    "64a000000000000000000005",
  ],
};

async function seed() {
  if (await prisma.building.count()) {
    console.log("Database already contains buildings; development seed skipped.");
    return;
  }

  const buildings = [
    { id: fixedIds.buildings[0], name: "Main Building", location: "14.0692,100.6041" },
    { id: fixedIds.buildings[1], name: "Library", location: "14.0701,100.6025" },
    { id: fixedIds.buildings[2], name: "Engineering", location: "14.0680,100.6062" },
    { id: fixedIds.buildings[3], name: "Student Center", location: "14.0711,100.6050" },
    { id: fixedIds.buildings[4], name: "Dormitory", location: "14.0667,100.6034" },
  ];
  for (const building of buildings) await prisma.building.create({ data: building });

  const tanks = [
    { id: "64a000000000000000000101", buildingId: buildings[0].id, tankName: "Main Reservoir", capacityLiter: 80000, currentLevelLiter: 62400 },
    { id: "64a000000000000000000102", buildingId: buildings[1].id, tankName: "Library Tank", capacityLiter: 24000, currentLevelLiter: 12960 },
    { id: "64a000000000000000000103", buildingId: buildings[2].id, tankName: "Engineering Tank", capacityLiter: 36000, currentLevelLiter: 9360 },
    { id: "64a000000000000000000104", buildingId: buildings[3].id, tankName: "Student Center Tank", capacityLiter: 28000, currentLevelLiter: 21840 },
    { id: "64a000000000000000000105", buildingId: buildings[4].id, tankName: "Dormitory Tank", capacityLiter: 44000, currentLevelLiter: 30800 },
  ];
  const settings = await prisma.systemSettings.create({
    data: {
      id: "64a000000000000000000099",
      waterPricePerM3: 18,
      lowWaterThreshold: 60,
      criticalWaterThreshold: 30,
      autoStartThreshold: 30,
      autoStopThreshold: 80,
    },
  });
  const tankRecords = [];
  for (const tank of tanks) {
    const percent = tank.currentLevelLiter / tank.capacityLiter * 100;
    tankRecords.push(await prisma.waterTank.create({
      data: {
        ...tank,
        currentLevelPercent: percent,
        status: percent < settings.criticalWaterThreshold ? "CRITICAL" : percent < settings.lowWaterThreshold ? "WARNING" : "NORMAL",
        leakStatus: "CLEAR",
      },
    }));
  }

  const pumps = [
    ["P-MB1", "Booster Pump 1", 0, "ON", "AUTO", 142, 428],
    ["P-MB2", "Booster Pump 2", 0, "OFF", "AUTO", 0, 317],
    ["P-LB1", "Library Pump 1", 1, "ON", "MANUAL", 86, 212],
    ["P-LB2", "Library Pump 2", 1, "OFF", "AUTO", 0, 175],
    ["P-EN1", "Engineering Pump 1", 2, "FAULT", "MANUAL", 0, 391],
    ["P-EN2", "Engineering Pump 2", 2, "OFF", "AUTO", 0, 268],
    ["P-DM1", "Dormitory Pump 1", 4, "ON", "AUTO", 118, 506],
    ["P-DM2", "Dormitory Pump 2", 4, "OFF", "AUTO", 0, 233],
  ] as const;
  const pumpRecords = [];
  for (const [pumpCode, pumpName, buildingIndex, status, controlMode, flowRate, operatingHours] of pumps) {
    pumpRecords.push(await prisma.pump.create({
      data: {
        pumpCode,
        pumpName,
        buildingId: buildings[buildingIndex].id,
        status,
        controlMode,
        flowRate,
        operatingHours,
        isOnline: pumpCode !== "P-EN1",
      },
    }));
  }

  const now = new Date();
  for (let dayOffset = 29; dayOffset >= 0; dayOffset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOffset));
    for (let index = 0; index < buildings.length; index += 1) {
      const liters = Math.round((index === 0 ? 6400 : 2100 + index * 700) * (0.82 + Math.random() * 0.36));
      await prisma.dailyWaterUsage.create({
        data: {
          date,
          buildingId: buildings[index].id,
          totalUsageLiter: liters,
          averageFlowRate: Math.round(liters / 1440 * 100) / 100,
          peakFlowRate: Math.round((30 + Math.random() * 100) * 100) / 100,
          estimatedCost: liters * settings.waterPricePerM3 / 1000,
        },
      });
    }
  }

  for (let monthOffset = 11; monthOffset >= 0; monthOffset -= 1) {
    const monthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthOffset, 1));
    const month = monthDate.getUTCMonth() + 1;
    const year = monthDate.getUTCFullYear();
    const monthRows = await prisma.dailyWaterUsage.findMany({
      where: { date: { gte: monthDate, lt: new Date(Date.UTC(year, month, 1)) } },
    });
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const breakdown = buildings.map((building, index) => {
      const observed = monthRows.filter((row) => row.buildingId === building.id)
        .reduce((total, row) => total + row.totalUsageLiter, 0);
      const dailyBase = index === 0 ? 6400 : 2100 + index * 700;
      return {
        buildingId: building.id,
        buildingName: building.name,
        usageLiter: observed || Math.round(dailyBase * daysInMonth * (0.9 + Math.random() * 0.2)),
      };
    });
    const totalUsageLiter = breakdown.reduce((total, row) => total + row.usageLiter, 0);
    await prisma.monthlyWaterBill.create({
      data: {
        month,
        year,
        totalUsageLiter,
        totalUsageM3: totalUsageLiter / 1000,
        totalCost: totalUsageLiter * settings.waterPricePerM3 / 1000,
        averageDailyUsage: totalUsageLiter / Math.max(1, new Set(monthRows.map((row) => row.date.toISOString())).size || daysInMonth),
        buildingBreakdown: breakdown,
      },
    });
  }

  for (let hourOffset = 23; hourOffset >= 0; hourOffset -= 1) {
    const recordedAt = new Date(now.getTime() - hourOffset * 60 * 60 * 1000);
    for (let index = 0; index < tankRecords.length; index += 1) {
      const tank = tankRecords[index];
      const waterLevelPercent = Math.min(98, Math.max(20, tank.currentLevelPercent - hourOffset * 0.16 + Math.random() * 2));
      await prisma.sensorReading.create({
        data: {
          tankId: tank.id,
          waterLevel: tank.capacityLiter * waterLevelPercent / 100,
          waterLevelPercent,
          flowRate: Math.round((25 + Math.random() * 90) * 100) / 100,
          leakDetected: false,
          source: "MOCK",
          recordedAt,
        },
      });
    }
  }

  const alerts = [
    {
      buildingId: buildings[2].id,
      pumpId: pumpRecords[4].id,
      alertType: "PUMP_FAULT",
      severity: "CRITICAL" as const,
      message: "P-EN1 reports a motor fault. Check the pump before restarting.",
    },
    {
      buildingId: buildings[2].id,
      tankId: tankRecords[2].id,
      alertType: "TANK_LEVEL_LOW",
      severity: "WARNING" as const,
      message: "Engineering Tank is below the 30% reserve threshold.",
    },
    {
      buildingId: buildings[1].id,
      alertType: "SENSOR_OFFLINE",
      severity: "INFO" as const,
      message: "Sensor telemetry recovered and is reporting normally.",
      isAcknowledged: true,
    },
  ];
  for (const alert of alerts) await prisma.alert.create({ data: alert });

  const runningPumps = pumpRecords.filter((pump) => pump.status === "ON");
  for (const pump of runningPumps) {
    await prisma.pumpLog.create({
      data: {
        pumpId: pump.id,
        buildingId: pump.buildingId,
        action: "START",
        controlMode: pump.controlMode,
        reason: "Development sample: automatic tank refill",
        flowRate: pump.flowRate,
        startedAt: new Date(now.getTime() - (1 + Math.random() * 5) * 60 * 60 * 1000),
      },
    });
  }
  for (const pump of pumpRecords.filter((item) => item.status === "FAULT")) {
    await prisma.pumpLog.create({
      data: {
        pumpId: pump.id,
        buildingId: pump.buildingId,
        action: "FAULT",
        controlMode: pump.controlMode,
        reason: "Development sample: motor protection trip",
        flowRate: 0,
      },
    });
  }
  console.log("Development seed created (sample readings are marked MOCK).");
}

seed()
  .catch((error: unknown) => {
    console.error("Development seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
