const API_URL = process.env.REACT_APP_API_URL ?? "http://localhost:4000/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export type Building = { id: string; name: string; location?: string | null };
export type Tank = {
  id: string; buildingId: string; buildingName: string; tankName: string;
  capacityLiter: number; currentLevelLiter: number; currentLevelPercent: number;
  status: "NORMAL" | "WARNING" | "CRITICAL"; leakStatus: "CLEAR" | "DETECTED"; updatedAt: string;
};
export type Pump = {
  id: string; buildingId: string; buildingName: string; pumpName: string; pumpCode: string;
  status: "ON" | "OFF" | "FAULT"; controlMode: "AUTO" | "MANUAL"; flowRate: number;
  operatingHours: number; isOnline: boolean; updatedAt: string;
};
export type Overview = {
  totalStorageLiter: number; totalCapacityLiter: number; storagePercent: number;
  currentUsageLpm: number; hourlyUsageLiter: number; estimatedDailyCost: number;
  monthCost: number; previousMonthCost: number; todayUsageLiter: number;
  yesterdayUsageLiter: number; weekUsageLiter: number; monthUsageLiter: number;
  activePumps: number; totalPumps: number; normalTanks: number; problemTanks: number;
  systemStatus: string; unacknowledgedAlerts: number; buildings: number;
};
export type UsagePoint = { label: string; usage: number; storage: number; source: string };
export type UsageStats = {
  todayLiter: number; weekLiter: number; monthLiter: number; averageDailyLiter: number;
  peakUsageTime: string | null;
  topBuilding: { buildingName: string; usageLiter: number } | null;
  buildings: { buildingName: string; usageLiter: number; estimatedCost: number }[];
};
export type EventItem = {
  id: string; kind: string; title: string; detail: string; severity: string;
  createdAt: string; buildingName: string;
};
export type PumpLog = {
  id: string; pumpId: string; pumpCode: string; buildingName: string;
  action: "START" | "STOP" | "FAULT"; controlMode: "AUTO" | "MANUAL";
  reason: string; createdAt: string; startedAt?: string | null; stoppedAt?: string | null;
};
export type Settings = {
  id: string; waterPricePerM3: number; lowWaterThreshold: number;
  criticalWaterThreshold: number; autoStartThreshold: number; autoStopThreshold: number;
  emergencyStop: boolean;
};

export const api = {
  overview: () => request<Overview>("/dashboard/overview"),
  tanks: () => request<Tank[]>("/tanks"),
  buildings: () => request<Building[]>("/buildings"),
  pumps: () => request<Pump[]>("/pumps"),
  usage: (range: string) => request<{ range: string; data: UsagePoint[] }>(`/dashboard/water-usage?range=${range}`),
  events: () => request<EventItem[]>("/dashboard/recent-events"),
  stats: () => request<UsageStats>("/usage/statistics"),
  logs: (days: number) => request<PumpLog[]>(`/pump-logs?days=${days}`),
  settings: () => request<Settings>("/settings"),
  updateSettings: (settings: Partial<Settings>) => request<Settings>("/settings", { method: "PUT", body: JSON.stringify(settings) }),
  setPumpMode: (id: string, controlMode: Pump["controlMode"]) =>
    request<Pump>(`/pumps/${id}/mode`, { method: "PUT", body: JSON.stringify({ controlMode }) }),
  commandPump: (id: string, action: "start" | "stop", reason: string) =>
    request<Pump>(`/pumps/${id}/${action}`, { method: "POST", body: JSON.stringify({ reason }) }),
  acknowledge: (id: string) =>
    request(`/alerts/${id}/acknowledge`, { method: "PUT", body: JSON.stringify({}) }),
};
