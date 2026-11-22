import { afterEach, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";

const originalFetch = global.fetch;
const overview = {
  totalStorageLiter: 12000, totalCapacityLiter: 20000, storagePercent: 60,
  currentUsageLpm: 24, hourlyUsageLiter: 1440, estimatedDailyCost: 220,
  monthCost: 5400, previousMonthCost: 5900, todayUsageLiter: 12000,
  yesterdayUsageLiter: 14000, weekUsageLiter: 80000, monthUsageLiter: 240000,
  activePumps: 1, totalPumps: 2, normalTanks: 1, problemTanks: 0,
  systemStatus: "ONLINE", unacknowledgedAlerts: 0, buildings: 1,
};
const building = { id: "64a000000000000000000001", name: "Main Building", location: "14,100" };
const tank = {
  id: "64a000000000000000000101", buildingId: building.id, buildingName: building.name,
  tankName: "Main Reservoir", capacityLiter: 20000, currentLevelLiter: 12000,
  currentLevelPercent: 60, status: "NORMAL", leakStatus: "CLEAR", updatedAt: new Date().toISOString(),
};
const pump = {
  id: "64a000000000000000000201", buildingId: building.id, buildingName: building.name,
  pumpName: "Booster Pump", pumpCode: "P-MB1", status: "OFF", controlMode: "AUTO",
  flowRate: 0, operatingHours: 120, isOnline: true, updatedAt: new Date().toISOString(),
};
const stats = {
  todayLiter: 12000, weekLiter: 80000, monthLiter: 240000, averageDailyLiter: 12000,
  peakUsageTime: "2:15 PM",
  topBuilding: { buildingName: building.name, usageLiter: 240000 },
  buildings: [{ buildingName: building.name, usageLiter: 240000, estimatedCost: 4320 }],
};

beforeAll(() => {
  class ResizeObserverMock implements ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverMock;
});

beforeEach(() => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    let payload: unknown = {};
    if (url.endsWith("/dashboard/overview")) payload = overview;
    else if (url.endsWith("/tanks")) payload = [tank];
    else if (url.endsWith("/buildings")) payload = [building];
    else if (url.endsWith("/pumps")) payload = [pump];
    else if (url.includes("/dashboard/water-usage")) payload = { range: "24h", data: [{ label: "10 AM", usage: 120, storage: 60, source: "MOCK" }] };
    else if (url.endsWith("/dashboard/recent-events")) payload = [];
    else if (url.endsWith("/usage/statistics")) payload = stats;
    else if (url.endsWith("/settings")) payload = {
      id: "64a000000000000000000099", waterPricePerM3: 18, lowWaterThreshold: 60,
      criticalWaterThreshold: 30, autoStartThreshold: 30, autoStopThreshold: 80, emergencyStop: false,
    };
    else if (url.includes("/pump-logs")) payload = [];
    return { ok: true, status: 200, json: async () => payload } as Response;
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

test("loads overview data and navigates to pump operation", async () => {
  render(<App />);
  expect(await screen.findByText("Total water storage")).toBeTruthy();
  expect(screen.getByText("Main Reservoir")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /pump operation/i }));
  expect(await screen.findByText("System control")).toBeTruthy();
  expect(screen.getByText("Pump status by building")).toBeTruthy();
});
