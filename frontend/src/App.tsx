import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Bell, Check, ChevronDown,
  ChevronRight, CircleHelp, Clock3, Droplets, Gauge, LayoutDashboard, MapPin,
  Menu, MoreHorizontal, Settings2, ShieldCheck, Waves, X, Zap,
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api, Building, EventItem, Overview, Pump, PumpLog, Settings, Tank, UsagePoint, UsageStats } from "./api";
import "./App.css";

type Page = "overview" | "pumps";
type DataState = {
  overview: Overview; tanks: Tank[]; buildings: Building[]; pumps: Pump[];
  usage: UsagePoint[]; events: EventItem[]; stats: UsageStats;
};
type RequestState = "loading" | "ready" | "error";
const number = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
const currency = (value: number) => `฿${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)}`;
const ago = (date: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
};

function useCampusData(range: string) {
  const [data, setData] = useState<DataState | null>(null);
  const [state, setState] = useState<RequestState>("loading");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setError("");
      const [overview, tanks, buildings, pumps, usageResult, events, stats] = await Promise.all([
        api.overview(), api.tanks(), api.buildings(), api.pumps(), api.usage(range), api.events(), api.stats(),
      ]);
      setData({ overview, tanks, buildings, pumps, usage: usageResult.data, events, stats });
      setState("ready");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load campus data");
      setState("error");
    }
  }, [range]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { data, state, error, refresh };
}

function App() {
  const [page, setPage] = useState<Page>("overview");
  const [range, setRange] = useState("24h");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [selectedPump, setSelectedPump] = useState<Pump | null>(null);
  const [pendingCommand, setPendingCommand] = useState<"start" | "stop" | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const { data, state, error, refresh } = useCampusData(range);

  useEffect(() => {
    api.settings().then(setSettings).catch((reason: unknown) => {
      setActionError(reason instanceof Error ? reason.message : "Could not load settings");
    });
  }, []);

  const selectPage = (next: Page) => {
    setPage(next);
    setMobileNavOpen(false);
    setActionError("");
  };

  const runCommand = async () => {
    if (!selectedPump || !pendingCommand) return;
    setCommandBusy(true);
    setActionError("");
    try {
      await api.commandPump(selectedPump.id, pendingCommand, "Operator initiated from dashboard");
      setNotice(`${selectedPump.pumpCode} ${pendingCommand === "start" ? "started" : "stopped"} successfully`);
      setPendingCommand(null);
      setSelectedPump(null);
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Pump command failed");
    } finally {
      setCommandBusy(false);
    }
  };

  const changeMode = async (pump: Pump, mode: Pump["controlMode"]) => {
    try {
      await api.setPumpMode(pump.id, mode);
      setNotice(`${pump.pumpCode} switched to ${mode.toLowerCase()} mode`);
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Could not change control mode");
    }
  };

  const saveSettings = async (next: Partial<Settings>) => {
    try {
      const updated = await api.updateSettings(next);
      setSettings(updated);
      setSettingsOpen(false);
      setNotice("System settings saved");
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Could not save settings");
    }
  };

  return (
    <div className="app-shell min-h-screen bg-slate-50">
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Waves size={22} strokeWidth={2.2} /></div>
          <div><strong>aquasync</strong><span>CAMPUS WATER SYSTEM</span></div>
          <button className="icon-button mobile-close" onClick={() => setMobileNavOpen(false)} aria-label="Close menu"><X size={18} /></button>
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <button className={`nav-item ${page === "overview" ? "active" : ""}`} onClick={() => selectPage("overview")}>
            <LayoutDashboard size={18} /><span>Water overview</span><ChevronRight size={15} className="nav-chevron" />
          </button>
          <button className={`nav-item ${page === "pumps" ? "active" : ""}`} onClick={() => selectPage("pumps")}>
            <Gauge size={18} /><span>Pump operation</span><ChevronRight size={15} className="nav-chevron" />
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-icon"><CircleHelp size={17} /></div>
            <strong>Need a hand?</strong>
            <span>View the system guide</span>
            <button onClick={() => setNotice("Contact your campus system administrator for support.")}>Get support <ArrowUpRight size={13} /></button>
          </div>
          <div className="campus-profile">
            <div className="avatar">UC</div>
            <div><strong>University Campus</strong><span>Administrator</span></div>
            <MoreHorizontal size={19} className="muted-icon" />
          </div>
        </div>
      </aside>
      {mobileNavOpen && <button className="mobile-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div className="breadcrumb"><span>Campus</span><ChevronRight size={14} /><strong>{page === "overview" ? "Water overview" : "Pump operation"}</strong></div>
          <div className="topbar-right">
            <span className="live-indicator"><i /> Live system</span>
            <span className="topbar-divider" />
            <button className="icon-button" aria-label="Alerts" onClick={() => setNotice(`There are ${data?.overview.unacknowledgedAlerts ?? 0} alerts requiring attention.`)}>
              <Bell size={18} />{(data?.overview.unacknowledgedAlerts ?? 0) > 0 && <i className="notification-dot" />}
            </button>
            <button className="settings-button" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /><span>Settings</span></button>
          </div>
        </header>

        <div className="content-wrap">
          {state === "loading" && <div className="state-card"><span className="spinner" /><strong>Connecting to campus systems</strong><span>Loading the latest water data…</span></div>}
          {state === "error" && <div className="state-card error-state"><div className="state-icon"><AlertTriangle size={21} /></div><strong>Couldn’t load campus data</strong><span>{error}. Check the API connection and try again.</span><button className="primary-button" onClick={() => void refresh()}>Retry connection</button></div>}
          {state === "ready" && data && (page === "overview"
            ? <OverviewPage data={data} range={range} setRange={setRange} onAcknowledge={async (id) => {
                try { await api.acknowledge(id); await refresh(); } catch (reason) {
                  setActionError(reason instanceof Error ? reason.message : "Could not acknowledge alert");
                }
              }} />
            : <PumpsPage data={data} settings={settings} logs={[]} selectedPump={selectedPump} onSelectPump={setSelectedPump}
                onCommand={(pump, action) => { setSelectedPump(pump); setPendingCommand(action); }}
                onChangeMode={changeMode} />)}
        </div>
        <footer className="page-footer"><span>© 2026 AquaSync Campus</span><span>Water intelligence for a sustainable campus</span><span>Last synced just now <i /></span></footer>
      </main>

      {actionError && <div className="toast toast-error" role="alert"><AlertTriangle size={17} /><span>{actionError}</span><button onClick={() => setActionError("")} aria-label="Dismiss"><X size={16} /></button></div>}
      {notice && <div className="toast" role="status"><Check size={17} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss"><X size={16} /></button></div>}
      {settingsOpen && settings && <SettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />}
      {pendingCommand && selectedPump && <ConfirmDialog pump={selectedPump} action={pendingCommand} busy={commandBusy}
        onCancel={() => { setPendingCommand(null); setActionError(""); }} onConfirm={runCommand} />}
    </div>
  );
}

function PageHeading({ eyebrow, title, description, right }: { eyebrow: string; title: string; description: string; right?: React.ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{right}</div>;
}

function StatCard({ label, value, unit, icon, tone, helper, delta }: {
  label: string; value: string; unit?: string; icon: React.ReactNode; tone: string; helper: string; delta?: { value: string; positive: boolean };
}) {
  return <article className="stat-card">
    <div className="stat-top"><span>{label}</span><span className={`stat-icon ${tone}`}>{icon}</span></div>
    <div className="stat-value">{value}<small>{unit}</small></div>
    <div className="stat-bottom"><span>{helper}</span>{delta && <span className={`delta ${delta.positive ? "delta-up" : "delta-down"}`}>{delta.positive ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{delta.value}</span>}</div>
  </article>;
}

function OverviewPage({ data, range, setRange, onAcknowledge }: {
  data: DataState; range: string; setRange: (value: string) => void; onAcknowledge: (id: string) => void;
}) {
  const usageChange = data.overview.yesterdayUsageLiter
    ? ((data.overview.todayUsageLiter - data.overview.yesterdayUsageLiter) / data.overview.yesterdayUsageLiter) * 100 : 0;
  const costChange = data.overview.previousMonthCost
    ? ((data.overview.monthCost - data.overview.previousMonthCost) / data.overview.previousMonthCost) * 100 : 0;
  return <>
    <PageHeading eyebrow="CAMPUS WATER INTELLIGENCE" title="Water overview" description="Monitor storage, usage and system health across your campus."
      right={<div className={`updated-chip ${data.overview.systemStatus !== "ONLINE" || data.overview.problemTanks > 0 ? "attention-chip" : ""}`}><span className="pulse-dot" />{data.overview.systemStatus === "ONLINE" && data.overview.problemTanks === 0 ? "All systems operational" : "Needs attention"}</div>} />
    <section className="stats-grid" aria-label="Water summary">
      <StatCard label="Total water storage" value={number(data.overview.totalStorageLiter)} unit="L" icon={<Droplets size={18} />} tone="blue" helper={`${data.overview.storagePercent.toFixed(0)}% full · ${number(data.overview.totalCapacityLiter)} L capacity`} />
      <StatCard label="Current water usage" value={data.overview.currentUsageLpm.toFixed(1)} unit="L/min" icon={<Waves size={18} />} tone="cyan" helper={`${number(data.overview.hourlyUsageLiter)} L in the last hour`} />
      <StatCard label="Estimated water cost" value={currency(data.overview.estimatedDailyCost)} icon={<span className="baht-mark">฿</span>} tone="violet" helper={`${currency(data.overview.monthCost)} month to date`} delta={{ value: `${Math.abs(costChange).toFixed(1)}% vs last month`, positive: costChange <= 0 }} />
      <StatCard label="Daily water usage" value={number(data.overview.todayUsageLiter)} unit="L" icon={<Activity size={18} />} tone="amber" helper={`${number(data.overview.yesterdayUsageLiter)} L yesterday`} delta={{ value: `${Math.abs(usageChange).toFixed(1)}% vs yesterday`, positive: usageChange <= 0 }} />
      <StatCard label="System status" value={data.overview.systemStatus === "ONLINE" ? "Healthy" : "Attention"} icon={<ShieldCheck size={18} />} tone="green" helper={`${data.overview.normalTanks} tanks normal · ${data.overview.problemTanks} need attention`} />
    </section>

    <div className="overview-grid">
      <section className="panel tank-panel">
        <div className="panel-header"><div><h2>Tank overview</h2><p>Water levels across campus buildings</p></div><button className="text-button">View all <ChevronRight size={15} /></button></div>
        {data.tanks.length === 0 ? <EmptyInline text="No tanks have been registered yet." /> : <div className="tank-grid">
          {data.tanks.map((tank) => {
            const buildingPump = data.pumps.find((pump) => pump.buildingId === tank.buildingId);
            return <TankCard key={tank.id} tank={tank} pump={buildingPump} />;
          })}
        </div>}
      </section>

      <section className="panel chart-panel">
        <div className="panel-header chart-heading"><div><h2>Water usage trend</h2><p>Consumption and storage levels over time</p></div>
          <div className="range-tabs">{[["24h", "24H"], ["7d", "7D"], ["30d", "30D"], ["12m", "12M"]].map(([value, label]) =>
            <button className={range === value ? "selected" : ""} key={value} onClick={() => setRange(value)}>{label}</button>)}</div>
        </div>
        {data.usage.length === 0 ? <EmptyInline text="No usage readings for this time range." /> : <div className="chart-wrap">
          <div className="chart-legend"><span><i className="legend-usage" />Water usage</span><span><i className="legend-storage" />Storage level</span></div>
          <ResponsiveContainer width="100%" height={218}>
            <AreaChart data={data.usage} margin={{ top: 8, right: 3, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="usageGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3781f7" stopOpacity={0.18} /><stop offset="95%" stopColor="#3781f7" stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid stroke="#eef2f7" vertical={false} />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#98a2b3", fontSize: 11 }} minTickGap={24} />
              <YAxis yAxisId="usage" axisLine={false} tickLine={false} tick={{ fill: "#98a2b3", fontSize: 11 }} />
              <YAxis yAxisId="storage" orientation="right" domain={[0, 100]} hide />
              <Tooltip contentStyle={{ border: "1px solid #e8edf4", borderRadius: 10, fontSize: 12 }} formatter={(value: number, name: string) => [name === "storage" ? `${value.toFixed(1)}%` : `${number(value)} L`, name === "storage" ? "Storage" : "Usage"]} />
              <Area yAxisId="usage" type="monotone" dataKey="usage" stroke="#3781f7" strokeWidth={2.5} fill="url(#usageGradient)" />
              <Area yAxisId="storage" type="monotone" dataKey="storage" stroke="#20b9a2" strokeWidth={2} strokeDasharray="5 5" fill="none" />
            </AreaChart>
          </ResponsiveContainer>
          {data.usage.some((point) => point.source === "MOCK") && <span className="mock-note">Sample sensor readings · development</span>}
        </div>}
      </section>
    </div>

    <div className="lower-grid">
      <section className="panel campus-panel">
        <div className="panel-header"><div><h2>Campus map</h2><p>Live tank status by location</p></div><button className="icon-button small-button" aria-label="Map options"><MoreHorizontal size={19} /></button></div>
        <CampusMap buildings={data.buildings} tanks={data.tanks} pumps={data.pumps} />
        <div className="map-legend"><span><i className="status-green" />Normal</span><span><i className="status-yellow" />Warning</span><span><i className="status-red" />Critical</span></div>
      </section>
      <section className="panel consumption-panel">
        <div className="panel-header"><div><h2>Consumption statistics</h2><p>Campus usage breakdown</p></div><button className="icon-button small-button" aria-label="More statistics"><MoreHorizontal size={19} /></button></div>
        <div className="usage-stats">
          <div><span>Today</span><strong>{number(data.stats.todayLiter)} <small>L</small></strong></div>
          <div><span>This week</span><strong>{number(data.stats.weekLiter)} <small>L</small></strong></div>
          <div><span>This month</span><strong>{number(data.stats.monthLiter)} <small>L</small></strong></div>
          <div><span>Daily average</span><strong>{number(data.stats.averageDailyLiter)} <small>L</small></strong></div>
          <div><span>Peak flow time</span><strong>{data.stats.peakUsageTime ?? "—"}</strong></div>
          <div><span>Top user</span><strong>{data.stats.topBuilding?.buildingName ?? "—"}</strong></div>
        </div>
        <div className="building-usage-title"><span>Usage by building</span><span>MONTH TO DATE</span></div>
        {data.stats.buildings.slice(0, 4).map((building, index) =>
          <div className="building-usage" key={building.buildingName}>
            <div className="building-usage-label"><span><i className={`building-dot dot-${index}`} />{building.buildingName}</span><strong>{currency(building.estimatedCost)}</strong></div>
            <div className="usage-track"><i style={{ width: `${Math.max(3, building.usageLiter / Math.max(1, data.stats.buildings[0]?.usageLiter) * 100)}%` }} /></div>
          </div>)}
      </section>
    </div>

    <section className="panel events-panel">
      <div className="panel-header"><div><h2>Recent events & alerts</h2><p>Latest activity from across the campus</p></div><button className="text-button">View all <ChevronRight size={15} /></button></div>
      {data.events.length === 0 ? <EmptyInline text="No recent events. Your campus is running smoothly." /> : <div className="event-list">
        {data.events.slice(0, 5).map((event) => <EventRow key={event.id} event={event} onAcknowledge={onAcknowledge} />)}
      </div>}
    </section>
  </>;
}

function TankCard({ tank, pump }: { tank: Tank; pump?: Pump }) {
  return <article className="tank-card">
    <div className="tank-card-head"><span className="tank-icon"><Droplets size={16} /></span><span className={`status-pill status-${tank.status.toLowerCase()}`}><i />{tank.status.toLowerCase()}</span></div>
    <strong className="tank-name">{tank.buildingName}</strong><span className="tank-subtitle">{tank.tankName}</span>
    <div className="tank-level"><strong>{tank.currentLevelPercent.toFixed(0)}<small>%</small></strong><span>{number(tank.currentLevelLiter)} / {number(tank.capacityLiter)} L</span></div>
    <div className="level-track"><i className={`level-${tank.status.toLowerCase()}`} style={{ width: `${Math.min(100, Math.max(0, tank.currentLevelPercent))}%` }} /></div>
    <div className="tank-foot"><span className={tank.leakStatus === "DETECTED" ? "text-critical" : ""}><i className={`mini-dot ${tank.leakStatus === "DETECTED" ? "status-red" : "status-green"}`} />{tank.leakStatus === "DETECTED" ? "Leak detected" : "No leak"}</span><span><Zap size={12} />Pump {pump?.status ?? "—"}</span></div>
  </article>;
}

function CampusMap({ buildings, tanks, pumps, onPumpClick }: {
  buildings: Building[]; tanks: Tank[]; pumps: Pump[]; onPumpClick?: (pump: Pump) => void;
}) {
  const positions = [[20, 32], [49, 18], [74, 36], [38, 67], [79, 72]];
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  return <div className="campus-map" aria-label="Schematic map of campus tank and pump locations">
    <div className="map-path path-one" /><div className="map-path path-two" /><div className="map-path path-three" />
    {buildings.map((building, index) => {
      const [left, top] = positions[index % positions.length];
      const tank = tanks.find((item) => item.buildingId === building.id);
      const pump = pumps.find((item) => item.buildingId === building.id);
      const state = tank?.status === "CRITICAL" ? "critical" : tank?.status === "WARNING" ? "warning" : "normal";
      return <div className="map-location" key={building.id} style={{ left: `${left}%`, top: `${top}%` }}>
        <button className={`map-pin ${state}`} aria-label={`${building.name} water details`} onClick={() => setSelectedBuildingId(selectedBuildingId === building.id ? null : building.id)}><Droplets size={14} /></button>
        <span className="map-label">{building.name}</span>
        {pump && onPumpClick && <button className={`map-pump ${pump.status === "FAULT" ? "fault" : ""}`} title={`${pump.pumpCode} · ${pump.status}`} onClick={() => onPumpClick(pump)}><Zap size={10} /></button>}
        {selectedBuildingId === building.id && <div className="map-popup"><strong>{building.name}</strong><span>Tank {tank ? `${tank.currentLevelPercent.toFixed(0)}% · ${number(tank.currentLevelLiter)} L` : "not configured"}</span><span>{pump ? `${pump.pumpCode} · ${pump.status}` : "No pump registered"}</span></div>}
      </div>;
    })}
    <div className="map-watermark"><MapPin size={13} /> UNIVERSITY CAMPUS</div>
  </div>;
}

function EventRow({ event, onAcknowledge }: { event: EventItem; onAcknowledge?: (id: string) => void }) {
  const isCritical = event.severity === "CRITICAL";
  return <div className="event-row">
    <span className={`event-icon ${isCritical ? "event-critical" : event.kind === "pump" ? "event-pump" : "event-info"}`}>
      {isCritical ? <AlertTriangle size={15} /> : event.kind === "pump" ? <Zap size={15} /> : <Droplets size={15} />}
    </span>
    <div className="event-copy"><strong>{event.title}</strong><span>{event.detail}</span></div>
    <span className="event-building">{event.buildingName}</span>
    <span className="event-time"><Clock3 size={13} />{ago(event.createdAt)}</span>
    {event.kind === "alert" && onAcknowledge && <button className="ack-button" onClick={() => onAcknowledge(event.id)}>Acknowledge</button>}
  </div>;
}

function PumpsPage({ data, settings, logs, selectedPump, onSelectPump, onCommand, onChangeMode }: {
  data: DataState; settings: Settings | null; logs: PumpLog[]; selectedPump: Pump | null; onSelectPump: (pump: Pump | null) => void;
  onCommand: (pump: Pump, action: "start" | "stop") => void;
  onChangeMode: (pump: Pump, mode: Pump["controlMode"]) => void;
}) {
  const [historyRange, setHistoryRange] = useState(1);
  const [pumpLogs, setPumpLogs] = useState<PumpLog[]>(logs);
  const [logsError, setLogsError] = useState("");
  useEffect(() => {
    api.logs(historyRange).then((result) => { setPumpLogs(result); setLogsError(""); })
      .catch((reason: unknown) => setLogsError(reason instanceof Error ? reason.message : "Could not load pump history"));
  }, [historyRange]);
  const faults = data.pumps.filter((pump) => pump.status === "FAULT").length;
  const totalFlow = data.pumps.reduce((sum, pump) => sum + (pump.status === "ON" ? pump.flowRate : 0), 0);
  const groups = useMemo(() => data.buildings.map((building) => ({
    building,
    pumps: data.pumps.filter((pump) => pump.buildingId === building.id),
  })).filter((group) => group.pumps.length > 0), [data.buildings, data.pumps]);
  const safeToStart = (pump: Pump) => pump.isOnline && pump.status !== "FAULT" && !settings?.emergencyStop && pump.status !== "ON";
  return <>
    <PageHeading eyebrow="CAMPUS WATER INTELLIGENCE" title="Pump operation" description="Monitor pump performance and manage water distribution."
      right={<div className="updated-chip"><span className="pulse-dot" /> Control system online</div>} />
    <section className="stats-grid pump-stats">
      <StatCard label="Total pumps" value={String(data.pumps.length).padStart(2, "0")} icon={<Gauge size={18} />} tone="blue" helper="Across all buildings" />
      <StatCard label="Currently running" value={String(data.overview.activePumps).padStart(2, "0")} icon={<Zap size={18} />} tone="green" helper="Pumps actively delivering" />
      <StatCard label="Stopped" value={String(data.pumps.filter((pump) => pump.status === "OFF").length).padStart(2, "0")} icon={<Activity size={18} />} tone="cyan" helper="Available for operation" />
      <StatCard label="Pump faults" value={String(faults).padStart(2, "0")} icon={<AlertTriangle size={18} />} tone="red" helper={faults ? "Requires inspection" : "No active faults"} />
      <StatCard label="Total flow rate" value={totalFlow.toFixed(1)} unit="L/min" icon={<Waves size={18} />} tone="violet" helper="Combined live flow" />
    </section>

    <div className="pump-layout">
      <div className="pump-main-column">
        <section className="panel control-panel">
          <div className="panel-header"><div><h2>System control</h2><p>Choose an operating mode for your campus pumps</p></div><span className="auto-badge"><span /> AUTO SYSTEM</span></div>
          <div className="control-mode-grid">
            <article className="mode-card">
              <span className="mode-icon auto-mode-icon"><Activity size={20} /></span><div className="mode-copy"><strong>Automatic mode</strong><span>System manages pump cycles based on tank levels.</span></div>
              <span className="mode-active"><i />{data.pumps.filter((pump) => pump.controlMode === "AUTO").length} active</span>
              <div className="mode-thresholds"><span>Start below <b>{settings?.autoStartThreshold ?? 30}%</b></span><span>Stop above <b>{settings?.autoStopThreshold ?? 80}%</b></span></div>
            </article>
            <article className="mode-card manual-mode-card">
              <span className="mode-icon manual-mode-icon"><Settings2 size={20} /></span><div className="mode-copy"><strong>Manual mode</strong><span>Take direct control of individual pumps.</span></div>
              <span className="mode-active"><i />{data.pumps.filter((pump) => pump.controlMode === "MANUAL").length} selected</span>
              <div className="mode-thresholds"><span>Operator controlled</span><span><ShieldCheck size={13} /> Safety checks enabled</span></div>
            </article>
          </div>
          <div className="control-safety"><ShieldCheck size={16} /><span>Safety interlocks active</span><span>Commands are blocked for offline, faulted or emergency-stopped pumps.</span><ChevronDown size={15} /></div>
        </section>

        <section className="panel pump-list-panel">
          <div className="panel-header"><div><h2>Pump status by building</h2><p>Select a pump to view controls and operating details</p></div><button className="text-button"><span className="pulse-dot" /> Live updates</button></div>
          <div className="pump-groups">
            {groups.map(({ building, pumps }) => <div className="pump-group" key={building.id}>
              <div className="pump-group-title"><span><MapPin size={14} />{building.name}</span><small>{pumps.length} pumps</small></div>
              <div className="pump-cards">{pumps.map((pump) => <PumpCard key={pump.id} pump={pump} selected={selectedPump?.id === pump.id}
                onSelect={() => onSelectPump(selectedPump?.id === pump.id ? null : pump)}
                onCommand={(action) => onCommand(pump, action)} onChangeMode={(mode) => onChangeMode(pump, mode)} canStart={safeToStart(pump)} />)}</div>
            </div>)}
          </div>
        </section>
      </div>
      <aside className="pump-side-column">
        <section className="panel pump-map-panel">
          <div className="panel-header"><div><h2>Pump locations</h2><p>Equipment status across campus</p></div></div>
          <CampusMap buildings={data.buildings} tanks={data.tanks} pumps={data.pumps} onPumpClick={onSelectPump} />
          <div className="map-legend"><span><i className="status-green" />Running / normal</span><span><i className="status-red" />Fault</span></div>
        </section>
        <section className="panel alerts-panel">
          <div className="panel-header"><div><h2>Alerts</h2><p>Needs your attention</p></div><span className="alert-count">{data.overview.unacknowledgedAlerts}</span></div>
          {data.events.filter((event) => event.kind === "alert").slice(0, 3).map((event) =>
            <div className="compact-alert" key={event.id}><span className={`alert-mini ${event.severity === "CRITICAL" ? "critical" : ""}`}><AlertTriangle size={14} /></span><div><strong>{event.title}</strong><span>{event.buildingName} · {ago(event.createdAt)}</span></div></div>)}
          {!data.events.some((event) => event.kind === "alert") && <EmptyInline text="No active alerts." />}
        </section>
      </aside>
    </div>

    <section className="panel history-panel">
      <div className="panel-header"><div><h2>Pump run history</h2><p>Recent start, stop and fault activity</p></div>
        <div className="range-tabs history-tabs">{[[1, "24H"], [7, "7D"], [30, "30D"]].map(([value, label]) =>
          <button className={historyRange === value ? "selected" : ""} key={value} onClick={() => setHistoryRange(Number(value))}>{label}</button>)}</div>
      </div>
      {logsError ? <EmptyInline text={logsError} /> : pumpLogs.length === 0 ? <EmptyInline text="No pump run history for this period." /> :
        <>
          <PumpHistoryTimeline pumps={data.pumps} logs={pumpLogs} days={historyRange} />
          <div className="history-table-wrap"><table className="history-table"><thead><tr><th>PUMP</th><th>BUILDING</th><th>EVENT</th><th>MODE</th><th>TIME</th><th>REASON</th></tr></thead>
            <tbody>{pumpLogs.slice(0, 12).map((log) => <tr key={log.id}><td><strong>{log.pumpCode}</strong></td><td>{log.buildingName}</td>
              <td><span className={`history-event event-${log.action.toLowerCase()}`}><i />{log.action}</span></td><td><span className="mode-label">{log.controlMode}</span></td>
              <td>{new Date(log.createdAt).toLocaleString()}</td><td className="reason-cell">{log.reason}</td></tr>)}</tbody></table></div>
        </>}
    </section>
  </>;
}

function PumpCard({ pump, selected, onSelect, onCommand, onChangeMode, canStart }: {
  pump: Pump; selected: boolean; onSelect: () => void; onCommand: (action: "start" | "stop") => void;
  onChangeMode: (mode: Pump["controlMode"]) => void; canStart: boolean;
}) {
  return <article className={`pump-card ${selected ? "pump-selected" : ""}`}>
    <button className="pump-card-select" onClick={onSelect} aria-label={`Select ${pump.pumpCode}`}>
      <span className={`pump-status-icon pump-${pump.status.toLowerCase()}`}><Gauge size={18} /></span>
      <span className="pump-card-heading"><strong>{pump.pumpCode}</strong><small>{pump.pumpName}</small></span>
      <span className={`pump-state state-${pump.status.toLowerCase()}`}><i />{pump.status}</span>
      <ChevronDown size={15} className="pump-expand" />
    </button>
    <div className="pump-card-metrics"><span><Waves size={13} />{pump.flowRate.toFixed(1)} L/min</span><span><Clock3 size={13} />{pump.operatingHours} hrs</span><span className={`control-tag ${pump.controlMode.toLowerCase()}`}>{pump.controlMode}</span></div>
    {selected && <div className="pump-controls">
      <div className="control-mode-toggle"><span>Control mode</span><div><button className={pump.controlMode === "AUTO" ? "on" : ""} onClick={() => onChangeMode("AUTO")}>AUTO</button><button className={pump.controlMode === "MANUAL" ? "on" : ""} onClick={() => onChangeMode("MANUAL")}>MANUAL</button></div></div>
      <div className="pump-action-buttons"><button className="start-button" disabled={!canStart || pump.controlMode !== "MANUAL"} onClick={() => onCommand("start")}><Zap size={14} />Start pump</button>
        <button className="stop-button" disabled={pump.status !== "ON" || pump.controlMode !== "MANUAL" || !pump.isOnline} onClick={() => onCommand("stop")}>Stop pump</button></div>
      {(pump.status === "FAULT" || !pump.isOnline) && <span className="pump-blocked"><AlertTriangle size={13} />{pump.status === "FAULT" ? "Fault must be cleared before operation." : "Pump is offline."}</span>}
      {pump.controlMode === "AUTO" && <span className="pump-blocked"><ShieldCheck size={13} />Switch to manual to issue a direct command.</span>}
    </div>}
  </article>;
}

function EmptyInline({ text }: { text: string }) {
  return <div className="empty-inline"><Droplets size={16} /><span>{text}</span></div>;
}

function PumpHistoryTimeline({ pumps, logs, days }: { pumps: Pump[]; logs: PumpLog[]; days: number }) {
  const end = Date.now();
  const start = end - days * 86400000;
  const span = end - start;
  return <div className="timeline">
    <div className="timeline-header"><span>PUMP</span><div><span>{new Date(start).toLocaleDateString()}</span><span>{new Date(end).toLocaleDateString()}</span></div></div>
    {pumps.map((pump) => {
      const starts = logs.filter((log): log is PumpLog & { startedAt: string } =>
        log.pumpId === pump.id && log.action === "START" && Boolean(log.startedAt))
        .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
      const segments: { left: number; width: number; state: "on" | "off" }[] = [];
      let cursor = start;
      if (starts.length === 0 && pump.status === "ON") {
        segments.push({ left: 0, width: 100, state: "on" });
        cursor = end;
      } else {
        for (const log of starts) {
          const actualStart = new Date(log.startedAt).getTime();
          const actualEnd = log.stoppedAt
            ? new Date(log.stoppedAt).getTime()
            : pump.status === "ON" && log === starts[starts.length - 1]
              ? end
              : new Date(log.createdAt).getTime();
          const clippedStart = Math.max(start, actualStart);
          const clippedEnd = Math.min(end, Math.max(clippedStart, actualEnd));
          if (clippedStart > cursor) segments.push({ left: (cursor - start) / span * 100, width: (clippedStart - cursor) / span * 100, state: "off" });
          if (clippedEnd > clippedStart) segments.push({ left: (clippedStart - start) / span * 100, width: (clippedEnd - clippedStart) / span * 100, state: "on" });
          cursor = Math.max(cursor, clippedEnd);
        }
        if (cursor < end) segments.push({ left: (cursor - start) / span * 100, width: (end - cursor) / span * 100, state: "off" });
      }
      const faults = logs.filter((log) => log.pumpId === pump.id && log.action === "FAULT" && new Date(log.createdAt).getTime() >= start);
      return <div className="timeline-row" key={pump.id}>
        <div className="timeline-pump"><strong>{pump.pumpCode}</strong><small>{pump.buildingName}</small></div>
        <div className="timeline-track" aria-label={`${pump.pumpCode} run history`}>
          {segments.map((segment, index) => <i key={`${pump.id}-${index}`} className={`timeline-segment ${segment.state}`} style={{ left: `${segment.left}%`, width: `${segment.width}%` }} />)}
          {faults.map((fault) => <i key={fault.id} className="timeline-fault" title={`Fault at ${new Date(fault.createdAt).toLocaleString()}`} style={{ left: `${Math.min(99, Math.max(0, (new Date(fault.createdAt).getTime() - start) / span * 100))}%` }} />)}
          {pump.status === "FAULT" && faults.length === 0 && <i className="timeline-fault" title="Pump is currently faulted" style={{ left: "99%" }} />}
        </div>
      </div>;
    })}
    <div className="timeline-legend"><span><i className="timeline-on" />Running</span><span><i className="timeline-off" />Stopped</span><span><i className="timeline-fault-key" />Fault</span></div>
  </div>;
}

function SettingsDialog({ settings, onClose, onSave }: {
  settings: Settings; onClose: () => void; onSave: (value: Partial<Settings>) => void;
}) {
  const [form, setForm] = useState({
    waterPricePerM3: String(settings.waterPricePerM3),
    lowWaterThreshold: String(settings.lowWaterThreshold),
    criticalWaterThreshold: String(settings.criticalWaterThreshold),
    autoStartThreshold: String(settings.autoStartThreshold),
    autoStopThreshold: String(settings.autoStopThreshold),
    emergencyStop: settings.emergencyStop,
  });
  const [error, setError] = useState("");
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const values = {
      waterPricePerM3: Number(form.waterPricePerM3),
      lowWaterThreshold: Number(form.lowWaterThreshold),
      criticalWaterThreshold: Number(form.criticalWaterThreshold),
      autoStartThreshold: Number(form.autoStartThreshold),
      autoStopThreshold: Number(form.autoStopThreshold),
    };
    if (Object.values(values).some((value) => !Number.isFinite(value) || value < 0 || value > 10000)) {
      setError("Enter valid non-negative values (thresholds should be at most 100%).");
      return;
    }
    if (values.criticalWaterThreshold >= values.lowWaterThreshold || values.autoStartThreshold >= values.autoStopThreshold || values.lowWaterThreshold > 100 || values.criticalWaterThreshold > 100 || values.autoStartThreshold > 100 || values.autoStopThreshold > 100) {
      setError("Critical/start thresholds must be lower than warning/stop thresholds; all thresholds must be 0–100%.");
      return;
    }
    onSave({ ...values, emergencyStop: form.emergencyStop });
  };
  const field = (key: keyof typeof form, label: string, unit: string) => <label className="settings-field" key={key}><span>{label}</span><div><input type="number" min="0" max={unit === "฿/m³" ? undefined : "100"} step="any"
    value={String(form[key])} onChange={(event) => setForm((value) => ({ ...value, [key]: event.target.value }))} /><small>{unit}</small></div></label>;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="dialog-heading"><div className="dialog-icon"><Settings2 size={19} /></div><button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={18} /></button></div>
      <h2 id="settings-title">System settings</h2><p>Configure water pricing and operating thresholds.</p>
      <form onSubmit={submit}><div className="settings-fields">
        {field("waterPricePerM3", "Water price", "฿/m³")}
        {field("lowWaterThreshold", "Warning level", "%")}
        {field("criticalWaterThreshold", "Critical level", "%")}
        {field("autoStartThreshold", "Auto-start level", "%")}
        {field("autoStopThreshold", "Auto-stop level", "%")}
      </div>
      <label className="emergency-toggle"><span><strong>Emergency stop</strong><small>Block all new pump start commands</small></span><input type="checkbox" checked={form.emergencyStop} onChange={(event) => setForm((value) => ({ ...value, emergencyStop: event.target.checked }))} /></label>
      {error && <div className="form-error"><AlertTriangle size={15} />{error}</div>}
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit">Save settings</button></div></form>
    </section>
  </div>;
}

function ConfirmDialog({ pump, action, busy, onCancel, onConfirm }: {
  pump: Pump; action: "start" | "stop"; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  return <div className="modal-backdrop"><section className="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
    <div className={`confirm-icon ${action}`}><AlertTriangle size={20} /></div><h2 id="confirm-title">{action === "start" ? "Start this pump?" : "Stop this pump?"}</h2>
    <p>{action === "start" ? "This will start" : "This will stop"} <strong>{pump.pumpCode} · {pump.buildingName}</strong>. The command will be recorded in the pump log.</p>
    <div className="dialog-actions"><button className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button><button className={`primary-button ${action === "stop" ? "danger-button" : ""}`} onClick={onConfirm} disabled={busy}>{busy ? "Sending…" : `Confirm ${action}`}</button></div>
  </section></div>;
}

export default App;
