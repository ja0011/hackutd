import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { tables, reducers } from './module_bindings';
import { useSpacetimeDB, useTable, useReducer } from 'spacetimedb/react';

// ─── helpers ──────────────────────────────────────────────
type Micros = { microsSinceUnixEpoch: bigint };
const toDate = (ts: Micros) => new Date(Number(ts.microsSinceUnixEpoch / 1000n));
const clock = (ts?: Micros) =>
  ts ? toDate(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const ago = (ts?: Micros) => {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - toDate(ts).getTime()) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
const initials = (n: string) => n.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();

const ACTING_KEY = 'acting_tech_id';
type View = 'overview' | 'warnings' | 'racks' | 'handoffs' | 'record';

const tone: Record<string, string> = {
  ok: 'green', warning: 'amber', critical: 'red', down: 'red',
  low: 'blue', medium: 'amber',
  open: 'red', claimed: 'blue', fixing: 'amber', resolved: 'green',
  pending: 'amber', complete: 'green', in_progress: 'blue', done: 'green', failed: 'red',
};
const Chip = ({ v, label }: { v: string; label?: string }) => (
  <span className={`chip ${tone[v] ?? 'gray'}`}>{(label ?? v).replace('_', ' ')}</span>
);

// ─── issue types ──────────────────────────────────────────
type RackRow = { temperatureF: number; powerKw: number; humidityPct: number; diskErrors: number; packetLossPct: number; pduALoadPct: number; pduBLoadPct: number };
const KINDS: Record<string, { title: string; emoji: string; label: string; unit: string; warn: number; ok: number; read?: (r: RackRow) => number; digits: number }> = {
  cooling: { title: 'Overheating', emoji: '', label: 'Temperature', unit: '°F', warn: 82, ok: 78, read: r => r.temperatureF, digits: 1 },
  power: { title: 'Power draw spike', emoji: '', label: 'Power draw', unit: ' kW', warn: 14, ok: 12, read: r => r.powerKw, digits: 1 },
  disk: { title: 'Disk errors rising', emoji: '', label: 'Disk errors', unit: '', warn: 10, ok: 1, read: r => r.diskErrors, digits: 0 },
  network: { title: 'Network packet loss', emoji: '', label: 'Packet loss', unit: '%', warn: 3, ok: 1, read: r => r.packetLossPct, digits: 1 },
  humidity: { title: 'Humidity out of range', emoji: '', label: 'Humidity', unit: '% RH', warn: 60, ok: 55, read: r => r.humidityPct, digits: 0 },
  pdu: { title: 'PDU power feed', emoji: '', label: 'PDU load', unit: '%', warn: 80, ok: 70, read: r => Math.max(r.pduALoadPct, r.pduBLoadPct), digits: 0 },
  cdu: { title: 'CDU coolant failure', emoji: '', label: 'Coolant flow', unit: ' L/min', warn: 90, ok: 105, digits: 0 },
  reported: { title: 'Reported issue', emoji: '', label: '', unit: '', warn: 0, ok: 0, digits: 0 },
};
// Rack-level faults you can simulate (CDU faults live on the CDU cards).
const RACK_FAULTS: { id: string; label: string }[] = [
  { id: 'cooling', label: 'Fan / airflow failure' },
  { id: 'power', label: 'Power draw spike (overload)' },
  { id: 'pdu', label: 'Lose PDU A feed' },
  { id: 'disk', label: 'Failing disk' },
  { id: 'network', label: 'Bad network cable' },
  { id: 'humidity', label: 'Humidity rising' },
];
const kindOf = (k: string) => KINDS[k] ?? KINDS.reported;
const fmt = (k: string, r?: RackRow) => {
  const m = kindOf(k);
  return r && m.read ? `${m.read(r).toFixed(m.digits)}${m.unit}` : '—';
};
const SENSOR_KEYS = ['cooling', 'power', 'disk', 'network', 'humidity'];
const pduText = (online: boolean, load: number) => (online ? `${load.toFixed(0)}%` : 'OFF');

// ─── icons ────────────────────────────────────────────────
const I = {
  home: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z',
  alert: 'M12 3l10 18H2L12 3zm0 6v5m0 3v.5',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  swap: 'M7 7h13l-3-3M17 17H4l3 3',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
};
const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

function Sparkline({ values, h = 32 }: { values: number[]; h?: number }) {
  if (values.length < 2) return <svg width="100%" height={h} />;
  const min = Math.min(66, ...values), max = Math.max(94, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${h - ((v - min) / (max - min)) * h}`).join(' ');
  return (
    <svg width="100%" height={h} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none">
      <polyline points={`0,${h} ${pts} 100,${h}`} fill="currentColor" opacity=".08" />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const Stat = ({ label, value, sub, t }: { label: string; value: ReactNode; sub?: string; t?: string }) => (
  <div className={`stat ${t ?? ''}`}>
    <div className="stat-label">{label}</div>
    <div className="stat-value">{value}</div>
    {sub && <div className="stat-sub">{sub}</div>}
  </div>
);

// ─── app ──────────────────────────────────────────────────
export default function App() {
  const { isActive: connected } = useSpacetimeDB();

  const [techs] = useTable(tables.tech);
  const [racks] = useTable(tables.rack);
  const [readings] = useTable(tables.sensorReading);
  const [warnings] = useTable(tables.warning);
  const [tasks] = useTable(tables.task);
  const [handoffs] = useTable(tables.handoff);
  const [records] = useTable(tables.chainRecord);
  const [cdus] = useTable(tables.cdu);
  const [cduReadings] = useTable(tables.cduReading);

  const claimWarning = useReducer(reducers.claimWarning);
  const markFixed = useReducer(reducers.markFixed);
  const createHandoff = useReducer(reducers.createHandoff);
  const signHandoff = useReducer(reducers.signHandoff);
  const breakRack = useReducer(reducers.breakRack);
  const breakCdu = useReducer(reducers.breakCdu);
  const resetDemo = useReducer(reducers.resetDemo);
  const reportIssue = useReducer(reducers.reportIssue);
  const verifyFix = useReducer(reducers.verifyFix);

  const [view, setView] = useState<View>('overview');
  const [, setNow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow(n => n + 1), 5000); // refresh "x ago" labels
    return () => clearInterval(id);
  }, []);

  const [actingId, setActingId] = useState<string>(() => localStorage.getItem(ACTING_KEY) ?? '');
  useEffect(() => {
    if (techs.length && !techs.some(x => x.id.toString() === actingId)) setActingId(techs[0].id.toString());
  }, [techs, actingId]);
  useEffect(() => { if (actingId) localStorage.setItem(ACTING_KEY, actingId); }, [actingId]);
  const me = techs.find(x => x.id.toString() === actingId);
  const nameOf = (id?: bigint) => techs.find(x => x.id === id)?.name ?? '—';
  const busy = !connected || !me;

  const sortedRacks = useMemo(() => [...racks].sort((a, b) => a.id.localeCompare(b.id)), [racks]);
  const sortedCdus = [...cdus].sort((a, b) => a.id.localeCompare(b.id));
  const cduHistory = (cduId: string) =>
    [...cduReadings].filter(x => x.cduId === cduId).sort((a, b) => (a.id < b.id ? -1 : 1)).map(x => x.flowLpm);
  const historyFor = (rackId: string, kind = 'cooling') =>
    [...readings].filter(r => r.rackId === rackId).sort((a, b) => (a.id < b.id ? -1 : 1)).map(r => kindOf(kind).read?.(r) ?? 0);
  const allWarnings = [...warnings].sort((a, b) => (a.id > b.id ? -1 : 1));
  const active = allWarnings.filter(w => w.status !== 'resolved');
  const unclaimed = active.filter(w => w.status === 'open');
  const pendingHandoffs = [...handoffs].filter(h => h.status === 'pending');
  const sortedHandoffs = [...handoffs].sort((a, b) => (a.id > b.id ? -1 : 1));
  const sortedRecords = [...records].sort((a, b) => (a.id > b.id ? -1 : 1));

  // ─── warnings view state ───
  const [filter, setFilter] = useState<'all' | 'open' | 'claimed' | 'fixing' | 'resolved'>('all');
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const filtered = allWarnings.filter(w => filter === 'all' || w.status === filter);
  const selected = allWarnings.find(w => w.id === selectedId) ?? filtered[0];

  // ─── handoff form ───
  const [handoffTo, setHandoffTo] = useState('');
  const [handoffNote, setHandoffNote] = useState('');

  // ─── report-an-issue form ───
  const [showReport, setShowReport] = useState(false);
  const [reportRack, setReportRack] = useState('');
  const [reportSev, setReportSev] = useState('medium');
  const [reportText, setReportText] = useState('');
  const submitReport = () => {
    if (!me || !reportRack || !reportText.trim()) return;
    reportIssue({ rackId: reportRack, techId: me.id, severity: reportSev, description: reportText });
    setReportText(''); setShowReport(false); setFilter('open'); setSelectedId(null); setView('warnings');
  };
  const reportForm = () => showReport && (
    <div className="panel report">
      <div className="panel-head"><h3>Report an issue sensors can't see</h3><button className="link" onClick={() => setShowReport(false)}>Cancel</button></div>
      <div className="row wrap">
        <label className="field grow">Rack
          <select value={reportRack} onChange={e => setReportRack(e.target.value)}>
            <option value="">Pick a rack…</option>
            {sortedRacks.map(r => <option key={r.id} value={r.id}>{r.id} (aisle {r.aisle})</option>)}
          </select>
        </label>
        <label className="field grow">Severity
          <select value={reportSev} onChange={e => setReportSev(e.target.value)}>
            <option value="low">Low</option><option value="medium">Medium</option><option value="critical">Critical</option>
          </select>
        </label>
      </div>
      <label className="field">What did you see?
        <textarea placeholder="e.g. Water pooling under R-14, burning smell near R-11, loose fiber cable on R-16…" value={reportText} onChange={e => setReportText(e.target.value)} />
      </label>
      <button className="primary" disabled={busy || !reportRack || !reportText.trim()} onClick={submitReport}>Submit report as {me?.name.split(' ')[0]}</button>
    </div>
  );

  const openWarning = (id: bigint) => { setSelectedId(id); setFilter('all'); setView('warnings'); };

  const nav: { id: View; label: string; icon: string; badge?: number }[] = [
    { id: 'overview', label: 'Overview', icon: I.home },
    { id: 'warnings', label: 'Warnings', icon: I.alert, badge: unclaimed.length || undefined },
    { id: 'racks', label: 'Racks', icon: I.server },
    { id: 'handoffs', label: 'Handoffs', icon: I.swap, badge: pendingHandoffs.length || undefined },
    { id: 'record', label: 'Signed Record', icon: I.shield },
  ];

  // Which sensor to graph: the faulted one, else the worst abnormal one, else temperature.
  const focusKind = (r: (typeof sortedRacks)[number]) =>
    (r.fault && r.fault !== 'pdu' ? r.fault : '') || SENSOR_KEYS.find(k => (kindOf(k).read?.(r) ?? 0) >= kindOf(k).warn) || 'cooling';

  const rackCard = (r: (typeof sortedRacks)[number], big?: boolean) => {
    const fk = focusKind(r);
    const m = kindOf(fk);
    const down = r.status === 'down';
    const oneFeed = r.pduAOnline !== r.pduBOnline;
    return (
      <div key={r.id} className={`rack ${tone[r.status]} ${down ? 'down' : ''}`}>
        <div className="row between">
          <b>{r.id}</b>
          <Chip v={r.status} label={down ? 'power lost' : r.status} />
        </div>
        {down ? (
          <div className="rack-temp red-text">OFFLINE</div>
        ) : (
          <div className="rack-temp">{m.read?.(r).toFixed(m.digits)}<span>{m.unit || ' errors'}</span></div>
        )}
        <div className="muted xxs">{down ? 'Both PDU feeds down' : m.label}</div>
        <div className="spark"><Sparkline values={historyFor(r.id, fk)} h={big ? 44 : 30} /></div>
        <div className={`pdu-row ${oneFeed || down ? 'red-text' : ''}`} title="Power Distribution Units: each server is plugged into both A and B">
          PDU A {pduText(r.pduAOnline, r.pduALoadPct)} · B {pduText(r.pduBOnline, r.pduBLoadPct)}
          {oneFeed && <b> · no backup</b>}
        </div>
        <div className="metrics">
          {SENSOR_KEYS.filter(k => k !== fk).map(k => {
            const km = kindOf(k);
            const bad = (km.read?.(r) ?? 0) >= km.warn;
            return <span key={k} className={bad ? 'red-text' : ''} title={km.label}>{km.label}: {fmt(k, r)}</span>;
          })}
        </div>
        <div className="row between muted xs">
          <span>Aisle {r.aisle}{r.fault ? <span className="red-text"> · {r.fault} fault</span> : null}</span>
          <select className="fault-pick" value="" disabled={!connected || down} onChange={e => e.target.value && breakRack({ rackId: r.id, fault: e.target.value })}>
            <option value="">simulate fault ▾</option>
            {RACK_FAULTS.filter(x => x.id !== r.fault).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </div>
      </div>
    );
  };

  const cduCard = (c: (typeof sortedCdus)[number]) => {
    const served = sortedRacks.filter(r => r.aisle === c.aisle).map(r => r.id).join(', ');
    return (
      <div key={c.id} className={`rack cdu ${tone[c.status]}`}>
        <div className="row between"><b>{c.id}</b><Chip v={c.status} /></div>
        <div className="rack-temp">{c.flowLpm.toFixed(0)}<span> L/min</span></div>
        <div className="muted xxs">Coolant flow (normal ~120)</div>
        <div className="spark"><Sparkline values={cduHistory(c.id)} h={30} /></div>
        <div className="metrics">
          <span className={c.pressureKpa < 160 ? 'red-text' : ''}>Pressure {c.pressureKpa.toFixed(0)} kPa</span>
          <span className={c.supplyTempC > 30 ? 'red-text' : ''}>Coolant {c.supplyTempC.toFixed(1)}°C</span>
        </div>
        <div className="row between muted xs">
          <span>Cools {served}{c.fault ? <span className="red-text"> · {c.fault} fault</span> : null}</span>
          {!c.fault && (
            <select className="fault-pick" value="" disabled={!connected} onChange={e => e.target.value && breakCdu({ cduId: c.id, fault: e.target.value })}>
              <option value="">simulate fault ▾</option>
              <option value="pump">Pump failure</option>
              <option value="leak">Coolant leak</option>
            </select>
          )}
        </div>
      </div>
    );
  };

  // ─── views ───
  const Overview = () => {
    const crit = racks.filter(r => r.status === 'critical' || r.status === 'down').length;
    const warn = racks.filter(r => r.status === 'warning').length;
    const racksOnline = racks.filter(r => r.status !== 'down').length;
    const redundant = racks.filter(r => r.pduAOnline && r.pduBOnline).length;
    const cdusOk = cdus.filter(c => c.status === 'ok').length;
    const lastIncident = allWarnings[0];
    // Unclaimed critical first, then by severity, then oldest first.
    const sevRank: Record<string, number> = { critical: 0, medium: 1, low: 2 };
    const queue = [...active].sort((a, b) => {
      const ua = a.status === 'open' && a.severity === 'critical' ? 0 : 1;
      const ub = b.status === 'open' && b.severity === 'critical' ? 0 : 1;
      if (ua !== ub) return ua - ub;
      const sr = (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3);
      if (sr) return sr;
      if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    return (
      <>
        <div className="page-head row between wrap"><div><h1>Overview</h1><p className="muted">Live floor status · updates every 3 seconds</p></div><button className="primary" onClick={() => setShowReport(true)}>+ Report issue</button></div>
        {reportForm()}
        <div className="stats">
          <Stat label="Racks healthy" value={`${racks.length - crit - warn}/${racks.length}`} t="green" />
          <Stat label="Open warnings" value={active.length} sub={`${unclaimed.length} unclaimed`} t={unclaimed.length ? 'red' : ''} />
          <Stat label="Pending handoffs" value={pendingHandoffs.length} t={pendingHandoffs.length ? 'amber' : ''} />
          <Stat label="Signed records" value={records.length} sub={`${records.filter(r => r.txSignature).length} on-chain`} />
        </div>
        <div className="two">
          <div className="panel">
            <div className="panel-head"><h3>Racks</h3><button className="link" onClick={() => setView('racks')}>View all</button></div>
            <div className="rack-grid">{sortedRacks.map(r => rackCard(r))}</div>
            <div className="panel-head" style={{ marginTop: 16 }}><h3>Liquid cooling (CDUs)</h3><span className="muted xxs">Each CDU pumps coolant to every rack in its aisle</span></div>
            <div className="rack-grid">{sortedCdus.map(c => cduCard(c))}</div>
          </div>
          <div className="side-col">
            <div className="panel">
              <div className="panel-head"><h3>Floor status</h3></div>
              <div className="status-grid">
                <div className={`status-cell ${racksOnline < racks.length ? 'bad' : ''}`}>
                  <div className="status-num">{racksOnline}/{racks.length}</div>
                  <div className="status-lbl">Racks online</div>
                </div>
                <div className={`status-cell ${redundant < racks.length ? 'warn' : ''}`}>
                  <div className="status-num">{redundant}/{racks.length}</div>
                  <div className="status-lbl">Dual PDU feeds</div>
                </div>
                <div className={`status-cell ${cdusOk < cdus.length ? 'bad' : ''}`}>
                  <div className="status-num">{cdusOk}/{cdus.length}</div>
                  <div className="status-lbl">CDUs healthy</div>
                </div>
                <div className="status-cell">
                  <div className="status-num">{lastIncident ? ago(lastIncident.createdAt).replace(' ago', '') : '—'}</div>
                  <div className="status-lbl">Since last incident</div>
                </div>
              </div>
            </div>

            <div className="panel queue">
              <div className="panel-head">
                <h3>Open issues <span className="count">{active.length}</span></h3>
                {active.length > 0 && <button className="link" onClick={() => setView('warnings')}>View all</button>}
              </div>
              {queue.map(w => (
                <div key={w.id.toString()} className={`q-row sev-${w.severity}`} onClick={() => openWarning(w.id)}>
                  <div className="q-main">
                    <div className="q-title">
                      <b>{w.rackId}</b>
                      <span>{kindOf(w.kind).title}</span>
                      {w.source === 'agent' && <span className="q-tag">AI</span>}
                    </div>
                    <div className="q-msg">{w.message}</div>
                    <div className="q-meta">
                      <span className={`sev-text-${w.severity}`}>{w.severity}</span>
                      <span>{ago(w.createdAt)}</span>
                      <span>{w.claimedBy !== undefined ? nameOf(w.claimedBy) : 'Unassigned'}</span>
                      {w.status === 'fixing' && <span>Verifying fix</span>}
                    </div>
                  </div>
                  {w.status === 'open' && (
                    <button className="q-claim" disabled={busy} onClick={e => { e.stopPropagation(); if (me) claimWarning({ warningId: w.id, techId: me.id }); }}>
                      Claim
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="panel">
              <div className="panel-head"><h3>Activity log</h3><button className="link" onClick={() => setView('record')}>Full record</button></div>
              <div className="log">
                {sortedRecords.slice(0, 6).map(rec => (
                  <div key={rec.id.toString()} className="log-row">
                    <span className="log-time">{clock(rec.createdAt).replace(/:\d\d (?=[AP]M)/, ' ')}</span>
                    <span className="log-text">
                      <span className="log-kind">{rec.kind === 'fix_verified' ? 'Verified' : rec.kind === 'claim' ? 'Claimed' : 'Handoff'}</span>
                      {rec.summary}
                    </span>
                    <span className={`log-chain ${rec.txSignature ? 'on' : ''}`} title={rec.txSignature ? 'Written to Solana devnet' : 'Waiting to be written on-chain'}>
                      {rec.txSignature ? 'On-chain' : 'Pending'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </>
    );
  };

  const Warnings = () => {
    const steps = selected ? [...tasks].filter(t0 => t0.warningId === selected.id).sort((a, b) => a.stepNumber - b.stepNumber) : [];
    const rack = selected ? racks.find(r => r.id === selected.rackId) : undefined;
    const mine = selected && me && selected.claimedBy === me.id;
    const reported = selected?.kind === 'reported';
    const km = selected ? kindOf(selected.kind) : undefined;
    const life = selected && km ? [
      { label: reported ? 'Issue reported' : 'Warning raised', detail: `${selected.source === 'agent' ? 'Nemotron agent' : selected.source === 'tech' ? nameOf(selected.reportedBy) : 'Sensor rule'} · ${clock(selected.createdAt)}`, done: true },
      { label: 'Claimed & signed', detail: selected.claimedAt ? `${nameOf(selected.claimedBy)} · ${clock(selected.claimedAt)}` : 'Waiting for an owner', done: !!selected.claimedAt, current: selected.status === 'open' },
      { label: 'Fix submitted', detail: selected.status === 'fixing' || selected.status === 'resolved' ? 'Tech marked the fix done' : 'Not yet', done: selected.status === 'fixing' || selected.status === 'resolved', current: selected.status === 'claimed' },
      reported
        ? { label: 'Verified by a second tech', detail: selected.resolvedAt ? `${nameOf(selected.verifiedBy)} · ${clock(selected.resolvedAt)}` : 'Someone other than the fixer must confirm', done: selected.status === 'resolved', current: selected.status === 'fixing' }
        : {
            label: 'Verified by data',
            detail: selected.resolvedAt
              ? `${km.label} back to normal · ${clock(selected.resolvedAt)}`
              : selected.kind === 'cdu'
                ? 'Waits for flow above 105 L/min and pressure above 190 kPa'
                : selected.kind === 'pdu'
                  ? 'Waits for both PDU feeds back online and load under 70%'
                  : `Waits for ${km.label.toLowerCase()} under ${km.ok}${km.unit}`,
            done: selected.status === 'resolved',
            current: selected.status === 'fixing',
          },
    ] : [];
    return (
      <div className="split">
        <div className="list-pane">
          <button className="primary full" onClick={() => setShowReport(s0 => !s0)}>+ Report issue</button>
          <div className="tabs">
            {(['all', 'open', 'claimed', 'fixing', 'resolved'] as const).map(f => (
              <button key={f} className={filter === f ? 'tab on' : 'tab'} onClick={() => setFilter(f)}>{f === 'open' ? 'Unclaimed' : f[0].toUpperCase() + f.slice(1)}</button>
            ))}
          </div>
          {filtered.length === 0 && <p className="empty">Nothing here.</p>}
          {filtered.map(w => (
            <button key={w.id.toString()} className={`list-item ${selected?.id === w.id ? 'sel' : ''}`} onClick={() => setSelectedId(w.id)}>
              <div className="row between"><b>{w.rackId} · {kindOf(w.kind).title}</b>{w.source === 'agent' && <Chip v="in_progress" label="AI" />}</div>
              <div className="muted xs clamp">{w.message}</div>
              <div className="row between xs"><span className="muted">{ago(w.createdAt)}</span><Chip v={w.status} label={w.status === 'open' ? 'unclaimed' : w.status} /></div>
            </button>
          ))}
        </div>

        <div className="detail-pane">
          {reportForm()}
          {!selected ? <p className="empty">Select a warning.</p> : (
            <>
              <div className="row between wrap">
                <h1>{selected.rackId} · {km?.title}</h1>
                <div className="row"><Chip v={selected.severity} /><Chip v={selected.status} label={selected.status === 'open' ? 'unclaimed' : selected.status} /></div>
              </div>
              <p className="muted">{selected.message}</p>

              <div className="stats three">
                {reported
                  ? <Stat label="Reported by" value={nameOf(selected.reportedBy)} />
                  : selected.kind === 'cdu'
                    ? (() => { const c = cdus.find(x => x.id === selected.rackId); return <Stat label="Coolant flow" value={c ? `${c.flowLpm.toFixed(0)} L/min` : '—'} sub={c ? `${c.pressureKpa.toFixed(0)} kPa · ${c.supplyTempC.toFixed(1)}°C` : ''} t={c && c.status !== 'ok' ? 'red' : 'green'} />; })()
                    : selected.kind === 'pdu'
                      ? <Stat label="PDU feeds" value={rack ? `A ${pduText(rack.pduAOnline, rack.pduALoadPct)} · B ${pduText(rack.pduBOnline, rack.pduBLoadPct)}` : '—'} t={rack && rack.pduAOnline && rack.pduBOnline ? 'green' : 'red'} />
                      : <Stat label={`Current ${km?.label.toLowerCase()}`} value={fmt(selected.kind, rack)} t={rack && km?.read && km.read(rack) >= km.warn ? 'red' : 'green'} />}
                <Stat label="Owner" value={selected.claimedBy !== undefined ? nameOf(selected.claimedBy) : 'Nobody'} t={selected.claimedBy === undefined ? 'red' : ''} />
                <Stat label="Opened" value={ago(selected.createdAt)} sub={clock(selected.createdAt)} />
              </div>

              <div className="actions">
                {selected.status === 'open' && <button className="primary" disabled={busy} onClick={() => me && claimWarning({ warningId: selected.id, techId: me.id })}>Claim & sign as {me?.name.split(' ')[0]}</button>}
                {selected.status === 'claimed' && (mine
                  ? <button className="primary" disabled={busy} onClick={() => me && markFixed({ warningId: selected.id, techId: me.id })}>Mark fix done</button>
                  : <span className="muted xs">Only {nameOf(selected.claimedBy)} can mark this fixed.</span>)}
                {selected.status === 'fixing' && !reported && <span className="muted xs">Watching sensor data to confirm the fix…</span>}
                {selected.status === 'fixing' && reported && (me && selected.claimedBy !== me.id
                  ? <button className="primary" disabled={busy} onClick={() => verifyFix({ warningId: selected.id, techId: me.id })}>Verify fix as {me.name.split(' ')[0]}</button>
                  : <span className="muted xs">Waiting for another tech to verify (switch "acting as" at the bottom left)</span>)}
                {selected.status === 'resolved' && <span className="green-text xs">✓ Verified and signed</span>}
              </div>

              <div className="panel">
                <h3>Accountability trail</h3>
                <div className="timeline">
                  {life.map((s, i) => (
                    <div key={i} className={`tl ${s.done ? 'done' : ''} ${s.current ? 'cur' : ''}`}>
                      <div className="tl-dot">{s.done ? '✓' : ''}</div>
                      <div><div className="tl-title">{s.label}</div><div className="muted xs">{s.detail}</div></div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel">
                <h3>Procedure steps</h3>
                {steps.length === 0 ? <p className="empty">The Nemotron agent's plan will appear here.</p> : (
                  <div className="timeline">
                    {steps.map(s => (
                      <div key={s.id.toString()} className={`tl ${s.status === 'done' ? 'done' : ''} ${s.status === 'in_progress' ? 'cur' : ''}`}>
                        <div className="tl-dot">{s.status === 'done' ? '✓' : ''}</div>
                        <div>
                          <div className="row"><span className="tl-title">Step {s.stepNumber}</span><Chip v={s.executor === 'agent' ? 'in_progress' : 'pending'} label={s.executor === 'agent' ? 'agent' : 'technician'} /><Chip v={s.status} /></div>
                          <div className="xs">{s.description}</div>
                          {s.result && <div className="muted xxs">{s.result}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  const Racks = () => (
    <>
      <div className="page-head"><div><h1>Racks</h1><p className="muted">Click "simulate fault" to break a rack's cooling for the demo.</p></div></div>
      <div className="rack-grid big">{sortedRacks.map(r => rackCard(r, true))}</div>
      <h2 className="section">Liquid cooling (CDUs)</h2>
      <div className="rack-grid big">{sortedCdus.map(c => cduCard(c))}</div>
    </>
  );

  const Handoffs = () => (
    <>
      <div className="page-head"><div><h1>Shift handoffs</h1><p className="muted">A handoff only completes when both techs sign. Open warnings move to the incoming tech.</p></div></div>
      <div className="two">
        <div className="panel">
          <h3>Start a handoff</h3>
          <label className="field">From<input value={me?.name ?? ''} disabled /></label>
          <label className="field">To
            <select value={handoffTo} onChange={e => setHandoffTo(e.target.value)}>
              <option value="">Pick a tech…</option>
              {techs.filter(x => x.id !== me?.id).map(x => <option key={x.id.toString()} value={x.id.toString()}>{x.name} ({x.shift})</option>)}
            </select>
          </label>
          <label className="field">Notes
            <textarea placeholder="Leave empty to auto-list your open warnings" value={handoffNote} onChange={e => setHandoffNote(e.target.value)} />
          </label>
          <button className="primary" disabled={busy || !handoffTo} onClick={() => { if (!me) return; createHandoff({ fromTechId: me.id, toTechId: BigInt(handoffTo), brief: handoffNote }); setHandoffNote(''); }}>Start handoff</button>
        </div>
        <div>
          {sortedHandoffs.length === 0 && <div className="panel"><p className="empty">No handoffs yet.</p></div>}
          {sortedHandoffs.map(h => {
            const canSign = me && h.status === 'pending' && ((me.id === h.fromTechId && h.fromSignedAt === undefined) || (me.id === h.toTechId && h.toSignedAt === undefined));
            const waitingOn = h.fromSignedAt === undefined ? h.fromTechId : h.toSignedAt === undefined ? h.toTechId : undefined;
            return (
              <div key={h.id.toString()} className="panel">
                <div className="row between"><b>{nameOf(h.fromTechId)} → {nameOf(h.toTechId)}</b><Chip v={h.status} /></div>
                <pre>{h.brief}</pre>
                <div className="sigs">
                  {[{ id: h.fromTechId, at: h.fromSignedAt, role: 'Outgoing' }, { id: h.toTechId, at: h.toSignedAt, role: 'Incoming' }].map(s => (
                    <div key={s.role} className={`sig ${s.at ? 'signed' : ''}`}>
                      <div className="avatar">{initials(nameOf(s.id))}</div>
                      <div><div className="xs"><b>{nameOf(s.id)}</b></div><div className="muted xxs">{s.role} · {s.at ? `signed ${clock(s.at)}` : 'not signed'}</div></div>
                    </div>
                  ))}
                </div>
                <div className="row between">
                  <span className="muted xs">{h.status === 'complete' ? `${h.openWarningIds.length} item(s) transferred` : `Waiting on ${nameOf(waitingOn)}`}</span>
                  {canSign && <button className="primary" disabled={busy} onClick={() => me && signHandoff({ handoffId: h.id, techId: me.id })}>Sign handoff</button>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );

  const Record = () => (
    <>
      <div className="page-head"><div><h1>Signed record</h1><p className="muted">Claims, verified fixes and handoffs. Each one is signed by the techs involved and written to Solana devnet, so nobody can change it later. Click a signature to see it on the Solana explorer.</p></div></div>
      <div className="panel">
        <table>
          <thead><tr><th>Time</th><th>Event</th><th>Who</th><th>Details</th><th>Chain</th></tr></thead>
          <tbody>
            {sortedRecords.map(rec => (
              <tr key={rec.id.toString()}>
                <td className="muted">{clock(rec.createdAt)}</td>
                <td><Chip v={rec.kind === 'fix_verified' ? 'resolved' : rec.kind === 'claim' ? 'claimed' : 'complete'} label={rec.kind.replace('_', ' ')} /></td>
                <td>{rec.techIds.map(id => nameOf(id)).join(' + ') || 'system'}</td>
                <td>{rec.summary}</td>
                <td className="mono">
                  {rec.txSignature
                    ? <a className="chain-link" href={`https://explorer.solana.com/tx/${rec.txSignature}?cluster=devnet`} target="_blank" rel="noreferrer">✓ {rec.txSignature.slice(0, 8)}… ↗</a>
                    : <span className="muted">pending</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 && <p className="empty">Nothing signed yet.</p>}
      </div>
    </>
  );

  return (
    <div className="shell">
      <style>{css}</style>
      <aside>
        <div className="brand"><div className="logo"><Icon d={I.bolt} /></div><span>Night Watch</span></div>
        <nav>
          {nav.map(n => (
            <button key={n.id} className={view === n.id ? 'nav on' : 'nav'} onClick={() => setView(n.id)}>
              <Icon d={n.icon} /><span>{n.label}</span>{n.badge ? <em>{n.badge}</em> : null}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <div className="row xs"><span className={`live ${connected ? 'on' : ''}`} />{connected ? 'Live · Spacetime' : 'Disconnected'}</div>
          <button className="link xs" onClick={() => resetDemo()} disabled={!connected}>Reset demo data</button>
          <div className="me">
            <div className="avatar">{me ? initials(me.name) : '?'}</div>
            <div className="me-info">
              <select value={actingId} onChange={e => setActingId(e.target.value)}>
                {techs.map(x => <option key={x.id.toString()} value={x.id.toString()}>{x.name}</option>)}
              </select>
              <div className="muted xxs">{me ? `${me.role} · ${me.shift} shift` : ''}</div>
              {me?.walletPubkey && <div className="muted xxs mono" title={me.walletPubkey}>{me.walletPubkey.slice(0, 4)}…{me.walletPubkey.slice(-4)}</div>}
            </div>
          </div>
        </div>
      </aside>
      <main>
        {view === 'overview' && Overview()}
        {view === 'warnings' && Warnings()}
        {view === 'racks' && Racks()}
        {view === 'handoffs' && Handoffs()}
        {view === 'record' && Record()}
      </main>
    </div>
  );
}

const css = `
  :root {
    --bg:#0b0d10; --side:#0f1216; --panel:#13161b; --panel2:#171b21; --line:#232830; --line2:#2c323b;
    --text:#e6e8eb; --muted:#8a919b; --faint:#5d646e;
    --accent:#4f8cff; --accent-d:#3a6fd8;
    --ok:#3fb27f; --warn:#e0a43a; --bad:#e5534b; --info:#6aa1ff;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:13.5px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing:antialiased; }
  button { font:inherit; color:inherit; }
  .shell { display:flex; min-height:100vh; background:var(--bg); }

  aside { width:232px; flex-shrink:0; background:var(--side); border-right:1px solid var(--line); display:flex; flex-direction:column; padding:16px 10px; position:sticky; top:0; height:100vh; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:600; font-size:15px; letter-spacing:-.01em; padding:4px 10px 20px; }
  .logo { width:28px; height:28px; border-radius:7px; background:var(--panel2); border:1px solid var(--line2); color:var(--text); display:grid; place-items:center; }
  nav { display:flex; flex-direction:column; gap:1px; }
  .nav { display:flex; align-items:center; gap:10px; background:none; border:0; padding:8px 10px; border-radius:6px; color:var(--muted); cursor:pointer; text-align:left; font-weight:500; }
  .nav:hover { background:var(--panel); color:var(--text); }
  .nav.on { background:var(--panel2); color:var(--text); box-shadow:inset 2px 0 0 var(--accent); }
  .nav span { flex:1; }
  .nav em { font-style:normal; font-size:11px; font-weight:600; background:var(--bad); color:#fff; border-radius:999px; padding:0 7px; line-height:18px; }
  .side-foot { margin-top:auto; display:flex; flex-direction:column; gap:10px; padding:0 8px; }
  .live { width:7px; height:7px; border-radius:50%; background:var(--bad); }
  .live.on { background:var(--ok); }
  .me { display:flex; gap:10px; align-items:center; border-top:1px solid var(--line); padding-top:12px; }
  .me-info { min-width:0; flex:1; }
  .me select { width:100%; background:none; border:0; color:var(--text); font-weight:600; padding:0; cursor:pointer; }
  .me select option { background:var(--panel); }
  .avatar { width:32px; height:32px; border-radius:50%; background:var(--panel2); border:1px solid var(--line2); color:var(--text); display:grid; place-items:center; font-weight:600; font-size:11.5px; flex-shrink:0; }

  main { flex:1; padding:28px 32px; min-width:0; }
  .page-head { margin-bottom:20px; }
  h1 { font-size:20px; margin:0 0 4px; font-weight:600; letter-spacing:-.015em; }
  h3 { font-size:11.5px; margin:0 0 12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
  p { margin:4px 0; }
  .muted { color:var(--muted); } .xs { font-size:12.5px; } .xxs { font-size:11.5px; }
  .row { display:flex; align-items:center; gap:8px; } .between { justify-content:space-between; } .wrap { flex-wrap:wrap; }

  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:20px; }
  .stats.three { grid-template-columns:repeat(3,1fr); margin:16px 0; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
  .stat-label { font-size:12px; color:var(--muted); }
  .stat-value { font-size:22px; font-weight:600; margin-top:4px; font-variant-numeric:tabular-nums; letter-spacing:-.01em; }
  .stat-sub { font-size:11.5px; color:var(--muted); }
  .stat.green .stat-value { color:var(--text); }
  .stat.amber { box-shadow:inset 3px 0 0 var(--warn); }
  .stat.red { box-shadow:inset 3px 0 0 var(--bad); }

  .two { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr); gap:16px; align-items:start; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:14px; }
  .panel-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; } .panel-head h3 { margin:0; }

  .rack-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:10px; }
  .rack-grid.big { grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); }
  .rack { border:1px solid var(--line); border-radius:8px; padding:12px; background:var(--panel2); }
  .rack.amber { border-color:rgba(224,164,58,.45); }
  .rack.red { border-color:rgba(229,83,75,.6); }
  .rack.down { background:rgba(229,83,75,.06); }
  .rack-temp { font-size:24px; font-weight:600; margin:8px 0 0; font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
  .rack-temp span { font-size:13px; color:var(--muted); font-weight:500; margin-left:3px; }
  .spark { color:var(--faint); margin:6px 0; } .rack.amber .spark { color:var(--warn); } .rack.red .spark { color:var(--bad); }
  .rack.cdu .spark { color:var(--info); }
  .metrics { display:flex; flex-wrap:wrap; gap:2px 10px; font-size:11px; color:var(--muted); margin-bottom:8px; font-variant-numeric:tabular-nums; }
  .pdu-row { font-size:11px; color:var(--muted); margin-bottom:2px; font-variant-numeric:tabular-nums; }

  .chip { font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; padding:1px 7px; border-radius:4px; border:1px solid; white-space:nowrap; }
  .chip.green { color:var(--ok); border-color:rgba(63,178,127,.35); }
  .chip.amber { color:var(--warn); border-color:rgba(224,164,58,.4); }
  .chip.red { color:var(--bad); border-color:rgba(229,83,75,.45); }
  .chip.blue { color:var(--info); border-color:rgba(106,161,255,.4); }
  .chip.gray { color:var(--muted); border-color:var(--line2); }
  .red-text { color:var(--bad); } .green-text { color:var(--ok); }

  .link { background:none; border:0; color:var(--muted); text-decoration:underline; text-underline-offset:2px; cursor:pointer; padding:0; font-size:12px; text-align:left; }
  .link:hover { color:var(--text); }
  button:disabled { opacity:.4; cursor:default; }
  .primary { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:8px 14px; font-weight:600; cursor:pointer; }
  .primary:hover:not(:disabled) { background:var(--accent-d); }
  .primary.full { width:100%; margin-bottom:12px; }

  .list-item { display:block; width:100%; text-align:left; background:none; border:0; border-bottom:1px solid var(--line); padding:12px 10px; cursor:pointer; border-radius:0; }
  .list-item:hover { background:var(--panel2); }
  .list-item.sel { background:var(--panel2); box-shadow:inset 2px 0 0 var(--accent); }
  .list-item > * + * { margin-top:4px; }
  .clamp { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .activity { display:flex; gap:10px; align-items:flex-start; padding:6px 0; } .dot { width:6px; height:6px; border-radius:50%; background:var(--faint); margin-top:7px; flex-shrink:0; }
  .empty { color:var(--muted); font-size:13px; padding:8px 0; }

  .split { display:grid; grid-template-columns:340px minmax(0,1fr); margin:-28px -32px; min-height:100vh; }
  .list-pane { border-right:1px solid var(--line); padding:20px 14px; overflow-y:auto; max-height:100vh; background:var(--side); }
  .detail-pane { padding:28px 32px; overflow-y:auto; max-height:100vh; }
  .tabs { display:flex; gap:2px; margin-bottom:10px; flex-wrap:wrap; border-bottom:1px solid var(--line); }
  .tab { background:none; border:0; color:var(--muted); padding:6px 10px; cursor:pointer; font-size:12.5px; font-weight:500; border-bottom:2px solid transparent; margin-bottom:-1px; }
  .tab.on { color:var(--text); border-bottom-color:var(--accent); }
  .actions { display:flex; gap:10px; align-items:center; margin:4px 0 16px; min-height:36px; }

  .timeline { display:flex; flex-direction:column; }
  .tl { display:flex; gap:12px; position:relative; padding-bottom:16px; }
  .tl:not(:last-child)::before { content:''; position:absolute; left:9px; top:22px; bottom:0; width:2px; background:var(--line); }
  .tl.done:not(:last-child)::before { background:var(--line2); }
  .tl-dot { width:20px; height:20px; border-radius:50%; border:2px solid var(--line2); display:grid; place-items:center; font-size:11px; flex-shrink:0; background:var(--panel); }
  .tl.done .tl-dot { background:var(--ok); border-color:var(--ok); color:#0b0d10; font-weight:700; }
  .tl.cur .tl-dot { border-color:var(--accent); }
  .tl-title { font-weight:600; }

  .field { display:flex; flex-direction:column; gap:5px; font-size:12px; color:var(--muted); margin-bottom:12px; }
  input, select, textarea { background:var(--bg); color:var(--text); border:1px solid var(--line2); border-radius:6px; padding:8px 10px; font:inherit; }
  input:focus, select:focus, textarea:focus { outline:none; border-color:var(--accent); }
  textarea { min-height:70px; resize:vertical; }
  pre { white-space:pre-wrap; font:12.5px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace; color:#c9cdd3; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 12px; margin:10px 0; }
  .sigs { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; }
  .sig { display:flex; gap:8px; align-items:center; border:1px dashed var(--line2); border-radius:8px; padding:8px; }
  .sig.signed { border-style:solid; border-color:rgba(63,178,127,.4); }

  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--muted); font-weight:500; font-size:12px; padding:8px; border-bottom:1px solid var(--line); }
  td { padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:hover td { background:var(--panel2); }
  .mono { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size:12px; }
  .chain-link { color:var(--accent); text-decoration:none; } .chain-link:hover { text-decoration:underline; }
  .fault-pick { background:none; border:0; padding:0; color:var(--muted); font-size:11.5px; text-decoration:underline; text-underline-offset:2px; cursor:pointer; max-width:120px; }
  .fault-pick option { background:var(--panel); color:var(--text); }
  .grow { flex:1; min-width:140px; }
  .report { border-color:var(--line2); }
  .side-col { display:flex; flex-direction:column; min-width:0; }
  .status-grid { display:grid; grid-template-columns:1fr 1fr; gap:1px; background:var(--line); border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  .status-cell { background:var(--panel2); padding:10px 12px; }
  .status-num { font-size:18px; font-weight:600; font-variant-numeric:tabular-nums; letter-spacing:-.01em; }
  .status-lbl { font-size:11.5px; color:var(--muted); }
  .status-cell.bad .status-num { color:var(--bad); }
  .status-cell.warn .status-num { color:var(--warn); }
  .count { display:inline-block; margin-left:6px; padding:0 6px; border-radius:4px; background:var(--panel2); border:1px solid var(--line2); color:var(--text); font-size:11px; letter-spacing:0; }
  .queue .panel-head { margin-bottom:8px; }
  .q-row { display:flex; gap:10px; align-items:center; padding:10px 10px 10px 12px; border:1px solid var(--line); border-left:3px solid var(--line2); border-radius:6px; background:var(--panel2); margin-bottom:6px; cursor:pointer; }
  .q-row:hover { border-color:var(--line2); }
  .q-row.sev-critical { border-left-color:var(--bad); }
  .q-row.sev-medium { border-left-color:var(--warn); }
  .q-row.sev-low { border-left-color:var(--info); }
  .q-main { flex:1; min-width:0; }
  .q-title { display:flex; gap:8px; align-items:baseline; font-size:13px; }
  .q-title span { color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .q-tag { font-size:10px; font-weight:600; color:var(--info) !important; border:1px solid rgba(106,161,255,.4); border-radius:3px; padding:0 4px; }
  .q-msg { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
  .q-meta { display:flex; gap:10px; font-size:11px; color:var(--faint); margin-top:4px; text-transform:none; }
  .q-meta span + span::before { content:'·'; margin-right:10px; color:var(--line2); }
  .sev-text-critical { color:var(--bad); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .sev-text-medium { color:var(--warn); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .sev-text-low { color:var(--info); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .q-claim { background:var(--accent); color:#fff; border:0; border-radius:5px; padding:6px 12px; font-weight:600; font-size:12px; cursor:pointer; flex-shrink:0; }
  .q-claim:hover:not(:disabled) { background:var(--accent-d); }
  .log { display:flex; flex-direction:column; }
  .log-row { display:grid; grid-template-columns:62px 1fr auto; gap:10px; align-items:baseline; padding:7px 0; border-bottom:1px solid var(--line); font-size:12px; }
  .log-row:last-child { border-bottom:0; }
  .log-time { color:var(--faint); font-variant-numeric:tabular-nums; }
  .log-text { color:var(--text); min-width:0; }
  .log-kind { color:var(--muted); font-weight:600; margin-right:6px; }
  .log-chain { font-size:10.5px; color:var(--faint); }
  .log-chain.on { color:var(--ok); }
  .section { font-size:11.5px; margin:24px 0 10px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.06em; }

  @media (max-width: 900px) {
    .shell { flex-direction:column; } aside { width:100%; height:auto; position:static; }
    nav { flex-direction:row; overflow-x:auto; } .side-foot { margin-top:12px; }
    main { padding:16px; } .stats { grid-template-columns:1fr 1fr; } .two, .split { grid-template-columns:1fr; } .split { margin:0; }
    .list-pane, .detail-pane { max-height:none; }
  }
`;
