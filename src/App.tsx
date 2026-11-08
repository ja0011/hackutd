import { useEffect, useMemo, useState } from 'react';
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
  paging: 'amber', acknowledged: 'green', missed: 'red', declined: 'red', skipped: 'gray', queued: 'blue',
  page_now: 'amber', holding: 'blue', symptom: 'gray',
};
tone.acknowledged = 'green';
tone.auto = 'blue';
// How each kind of signed record reads in the logs.
const REC_LABEL: Record<string, string> = { claim: 'Claimed', fix_verified: 'Verified', handoff: 'Handoff', paged: 'Paged', page_missed: 'Missed page', page_declined: 'Declined', page_held: 'Held', agent_action: 'Agent fixed' };
const REC_TONE: Record<string, string> = { claim: 'claimed', fix_verified: 'resolved', handoff: 'complete', paged: 'paging', page_missed: 'missed', page_declined: 'declined', page_held: 'queued', agent_action: 'acknowledged' };

// ─── timeline verification against Solana devnet ───
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}
// Same fingerprint the chain service writes (chain/chain.ts).
async function fingerprint(rec: { id: bigint; kind: string; refId: bigint; techIds: bigint[]; summary: string; createdAt: Micros }) {
  const canonical = JSON.stringify({ id: rec.id.toString(), kind: rec.kind, refId: rec.refId.toString(), techIds: rec.techIds.map(String), summary: rec.summary, at: rec.createdAt.microsSinceUnixEpoch.toString() });
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function memoOf(sig: string): Promise<{ sha256?: string; prev?: string } | null> {
  const res = await fetch('https://api.devnet.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] }),
  });
  const j = await res.json();
  const msg = j?.result?.transaction?.message;
  if (!msg) return null;
  const ix = msg.instructions.find((i: { programIdIndex: number }) => msg.accountKeys[i.programIdIndex] === MEMO_PROGRAM);
  return ix ? JSON.parse(new TextDecoder().decode(base58(ix.data))) : null;
}
type Check = { recordId: string; ok: boolean; note: string };

const PAGE_LABEL: Record<string, string> = { queued: 'waiting for shift', acknowledged: 'acknowledged', missed: 'no answer', declined: 'declined', skipped: 'not needed' };
const MODE_LABEL: Record<string, string> = { page_now: 'Paging now', holding: 'Holding for best person', symptom: 'Symptom of root cause', acknowledged: 'Acknowledged', resolved: 'Resolved', auto: 'Agent fixing it' };
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
// Rack-level faults you can simulate (the CDU pump failure lives on the CDU cards).
// The demo focuses on three faults: CDU pump failure, PDU feed loss and thermal drift.
const RACK_FAULTS: { id: string; label: string }[] = [
  { id: 'cooling', label: 'Thermal drift (fan failure)' },
  { id: 'pdu', label: 'Lose PDU A feed' },
  { id: 'power', label: 'Runaway job (agent fixes it)' },
];
// What to bring and what can hurt you, per fault type — the site's standard kit list.
const KIT: Record<string, { parts: string; hazard: string }> = {
  cdu: { parts: 'Pump cartridge, bleed kit, drip tray', hazard: 'Hot coolant and pressurised loop — gloves and eye protection' },
  pdu: { parts: 'Spare input cord, breaker key', hazard: 'Live electrical — lockout/tagout and arc-flash PPE' },
  cooling: { parts: 'Fan tray, blanking panels', hazard: 'Hot aisle, 90°F+ — hydrate, do not work alone over 95°F' },
  power: { parts: '', hazard: '' },
  disk: { parts: 'Spare drive, SATA cable', hazard: '' },
  network: { parts: 'Spare optic, fiber patch lead', hazard: '' },
  humidity: { parts: 'Door seal, humidifier filter', hazard: '' },
  reported: { parts: '', hazard: '' },
};

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

// (Stat tiles were replaced by the hero banner and the compact strip.)

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
  const [incidents] = useTable(tables.incident);
  const [pages] = useTable(tables.page);
  const [analyses] = useTable(tables.analysis);
  const [tenants] = useTable(tables.tenant);
  const [floors] = useTable(tables.floor);
  const [links] = useTable(tables.chainLink);
  const [signals] = useTable(tables.tenantSignal);
  const declinePage = useReducer(reducers.declinePage);
  const overridePriority = useReducer(reducers.overridePriority);
  const setShift = useReducer(reducers.setShift);

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
    const id = setInterval(() => setNow(n => n + 1), 1000); // refresh "x ago" labels and page countdowns
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

  // ─── escalation / incident data ───
  const shift = floors.find(f => f.id === 'main')?.currentShift ?? 'night';
  const incidentOf = (id: bigint) => incidents.find(i => i.warningId === id);
  const analysisOf = (id: bigint) => analyses.find(a => a.warningId === id);
  const pagesOf = (id: bigint) => [...pages].filter(p => p.warningId === id && p.status !== 'superseded').sort((a, b) => (a.id < b.id ? -1 : 1));
  const tenantOf = (rackId: string) => tenants.find(tn => tn.rackIds.split(',').includes(rackId));
  const secsLeft = (p: { timeoutSec: number; pagedAt: Micros }) => Math.max(0, p.timeoutSec - Math.floor((Date.now() - toDate(p.pagedAt).getTime()) / 1000));
  const myPages = me ? [...pages].filter(p => p.techId === me.id && p.status === 'paging') : [];
  const pageLabel = (p: { status: string; timeoutSec: number; pagedAt: Micros }) => (p.status === 'paging' ? `paging · ${secsLeft(p)}s` : PAGE_LABEL[p.status] ?? p.status);
  // One line for the queue: who is being paged right now, or why nobody is.
  const routingLine = (id: bigint) => {
    const inc = incidentOf(id);
    if (!inc) return '';
    if (inc.mode === 'symptom') return 'Symptom: covered by the CDU page';
    if (inc.mode === 'auto') return 'Nemotron agent fixing it';
    const cur = pagesOf(id).find(p => p.status === 'paging' || p.status === 'queued');
    if (!cur) return '';
    return cur.status === 'queued' ? `Holding for ${nameOf(cur.techId)}` : `Paging ${nameOf(cur.techId)} · ${secsLeft(cur)}s`;
  };

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
    // Only say something when something is wrong. A healthy rack shows its tenant and nothing else.
    const alerts = [
      ...(down ? ['No power'] : oneFeed ? [`PDU ${r.pduAOnline ? 'B' : 'A'} down`] : []),
      ...SENSOR_KEYS.filter(k => k !== fk && (kindOf(k).read?.(r) ?? 0) >= kindOf(k).warn).map(k => `${kindOf(k).label} ${fmt(k, r)}`),
    ];
    const tenant = tenantOf(r.id);
    return (
      <div key={r.id} className={`rack ${tone[r.status]} ${down ? 'down' : ''} ${big ? 'big' : ''}`}>
        <div className="row between">
          <b>{r.id}</b>
          {r.status === 'ok' ? <span className="dot ok" /> : <Chip v={r.status} label={down ? 'power lost' : r.status} />}
        </div>
        {down ? (
          <div className="rack-temp red-text">OFFLINE</div>
        ) : (
          <div className="rack-temp">{m.read?.(r).toFixed(m.digits)}<span>{m.unit || ' errors'}</span></div>
        )}
        <div className="spark"><Sparkline values={historyFor(r.id, fk)} h={big ? 44 : 34} /></div>
        {big && (
          <>
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
          </>
        )}
        <div className="tile-foot">
          {alerts.length && !big
            ? <span className="red-text">{alerts[0]}</span>
            : <span className="muted">{big ? m.label : tenant ? tenant.name.split(' ')[0] : `Aisle ${r.aisle}`}</span>}
          <select className="fault-pick" value="" disabled={!connected || down} onChange={e => e.target.value && breakRack({ rackId: r.id, fault: e.target.value })} title="Simulate a fault (demo)">
            <option value="">break ▾</option>
            {RACK_FAULTS.filter(x => x.id !== r.fault).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </div>
      </div>
    );
  };

  const cduCard = (c: (typeof sortedCdus)[number], big?: boolean) => {
    const served = sortedRacks.filter(r => r.aisle === c.aisle).map(r => r.id).join(', ');
    const bad = c.status !== 'ok';
    return (
      <div key={c.id} className={`rack cdu ${tone[c.status]} ${big ? 'big' : ''}`}>
        <div className="row between"><b>{c.id}</b>{c.status === 'ok' ? <span className="dot ok" /> : <Chip v={c.status} />}</div>
        <div className="rack-temp">{c.flowLpm.toFixed(0)}<span> L/min</span></div>
        <div className="spark"><Sparkline values={cduHistory(c.id)} h={big ? 44 : 34} /></div>
        {big && (
          <div className="metrics">
            <span className={c.pressureKpa < 160 ? 'red-text' : ''}>Pressure {c.pressureKpa.toFixed(0)} kPa</span>
            <span className={c.supplyTempC > 30 ? 'red-text' : ''}>Coolant {c.supplyTempC.toFixed(1)}°C</span>
          </div>
        )}
        <div className="tile-foot">
          {bad && !big
            ? <span className="red-text">{c.pressureKpa.toFixed(0)} kPa · cools {served}</span>
            : <span className="muted">Coolant flow · cools {served}</span>}
          {!c.fault && (
            <select className="fault-pick" value="" disabled={!connected} onChange={e => e.target.value && breakCdu({ cduId: c.id, fault: e.target.value })} title="Simulate a fault (demo)">
              <option value="">break ▾</option>
              <option value="pump">Pump failure</option>
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
    const redundant = racks.filter(r => r.pduAOnline && r.pduBOnline).length;
    const cdusOk = cdus.filter(c => c.status === 'ok').length;
    const sevRank: Record<string, number> = { critical: 0, medium: 1, low: 2 };
    // Priority = severity after the customer-sensitivity bump (or a supervisor override).
    const prio = (w: (typeof active)[number]) => incidentOf(w.id)?.priority ?? w.severity;
    const queue = [...active].sort((a, b) => {
      const ua = a.status === 'open' && prio(a) === 'critical' ? 0 : 1;
      const ub = b.status === 'open' && prio(b) === 'critical' ? 0 : 1;
      if (ua !== ub) return ua - ub;
      const sr = (sevRank[prio(a)] ?? 3) - (sevRank[prio(b)] ?? 3);
      if (sr) return sr;
      if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

    // ── The one thing to look at: the worst root-cause incident, and what it is costing ──
    const top = queue.find(w => incidentOf(w.id)?.mode !== 'symptom');
    const topInc = top ? incidentOf(top.id) : undefined;
    const topPage = top ? pagesOf(top.id).find(p => p.status === 'paging' || p.status === 'queued') : undefined;
    const topEta = topInc?.minutesToCritical ?? -1;
    const etaTxt = topEta === 0 ? 'now' : topEta > 0 ? (topEta < 1 ? `${Math.max(5, Math.round((topEta * 60) / 5) * 5)}s` : `${Math.round(topEta)} min`) : '';
    const burn = active.reduce((sum, w) => sum + (incidentOf(w.id)?.mode === 'symptom' ? 0 : incidentOf(w.id)?.costPerMinute ?? 0), 0);
    const pagedMe = !!(me && top && pages.some(p => p.techId === me.id && p.warningId === top.id && p.status === 'paging'));
    const heroTone = crit || queue.some(w => prio(w) === 'critical') ? 'bad' : active.length ? 'warn' : 'ok';
    const whoLine = !top ? '' :
      top.claimedBy !== undefined ? `${nameOf(top.claimedBy)} is on it`
      : topInc?.mode === 'auto' ? 'Nemotron agent is fixing it · nobody paged'
      : topPage?.status === 'paging' ? `Paging ${nameOf(topPage.techId)} · escalates in ${secsLeft(topPage)}s`
      : topPage ? `Holding for ${nameOf(topPage.techId)} next shift`
      : 'Nobody has it yet';
    const others = queue.length - 1;
    const agentFixes = [...records].filter(r => r.kind === 'agent_action').length;
    const ownedTimes = allWarnings.filter(w => w.claimedAt).map(w => Math.round((toDate(w.claimedAt!).getTime() - toDate(w.createdAt).getTime()) / 1000));
    const ownedAvg = ownedTimes.length ? Math.round(ownedTimes.reduce((x, y) => x + y, 0) / ownedTimes.length) : 0;
    const escalated = new Set(pages.filter(p => p.status === 'missed' || p.status === 'declined').map(p => p.warningId.toString())).size;
    const triedNoAnswer = new Set(pages.filter(p => (p.status === 'missed' || p.status === 'declined') && active.some(w => w.id === p.warningId)).map(p => p.techId.toString())).size;
    const beatLimit = allWarnings.filter(w => w.source === 'agent').length;
    const totalRaised = allWarnings.length;
    // On shift now, and what each person is carrying.
    const roster = techs
      .filter(t0 => t0.shift === shift || t0.role === 'supervisor')
      .map(t0 => {
        const paged = pages.find(p => p.techId === t0.id && p.status === 'paging');
        const owns = active.filter(w => w.claimedBy === t0.id).length;
        const missed = pages.filter(p => p.techId === t0.id && p.status === 'missed').length;
        return { t: t0, paged, owns, missed, onShift: t0.shift === shift };
      })
      .sort((a, b) => (a.paged ? 0 : 1) - (b.paged ? 0 : 1) || b.owns - a.owns);
    // My own work, first thing a tech looks for.
    const minePaged = me ? pages.filter(p => p.techId === me.id && p.status === 'paging') : [];
    const mineOwned = me ? active.filter(w => w.claimedBy === me.id) : [];
    // Techs walk to a place, not to an alarm: group the queue by aisle.
    const aisleOf = (w: (typeof active)[number]) => w.rackId.startsWith('CDU-') ? w.rackId.slice(-1) : racks.find(r => r.id === w.rackId)?.aisle ?? '?';
    const roots = queue.filter(w => incidentOf(w.id)?.mode !== 'symptom');
    const byAisle = [...new Set(roots.map(aisleOf))]
      .map(a0 => ({ aisle: a0, items: roots.filter(w => aisleOf(w) === a0) }))
      .sort((a, b) => (sevRank[prio(a.items[0])] ?? 3) - (sevRank[prio(b.items[0])] ?? 3));

    return (
      <>
        <div className="page-head row between wrap">
          <div><h1>Night Watch</h1><p className="muted">Data center floor · live, updates every 3 seconds</p></div>
          <button className="primary" onClick={() => setShowReport(true)}>+ Report issue</button>
        </div>
        {reportForm()}

        {(minePaged.length > 0 || mineOwned.length > 0) && (
          <div className="onme">
            <div className="onme-l">On you right now</div>
            {minePaged.map(p => {
              const w = warnings.find(x => x.id === p.warningId);
              if (!w) return null;
              const k = KIT[w.kind] ?? KIT.reported;
              return (
                <div key={`p${p.id}`} className="onme-row paged" onClick={() => openWarning(w.id)}>
                  <span className="onme-badge">PAGED · {secsLeft(p)}s</span>
                  <div className="grow">
                    <div className="onme-t">Aisle {aisleOf(w)} · {w.rackId} · {kindOf(w.kind).title}</div>
                    {k.parts && <div className="onme-s">Bring: {k.parts}</div>}
                  </div>
                  <button className="primary sm" disabled={busy} onClick={e => { e.stopPropagation(); me && claimWarning({ warningId: w.id, techId: me.id }); }}>Acknowledge</button>
                  <button className="ghost sm" disabled={busy} onClick={e => { e.stopPropagation(); me && declinePage({ warningId: w.id, techId: me.id }); }}>Can't take it</button>
                </div>
              );
            })}
            {mineOwned.map(w => (
              <div key={`o${w.id}`} className="onme-row" onClick={() => openWarning(w.id)}>
                <span className="onme-badge own">YOURS</span>
                <div className="grow">
                  <div className="onme-t">Aisle {aisleOf(w)} · {w.rackId} · {kindOf(w.kind).title}</div>
                  <div className="onme-s">{w.status === 'fixing' ? 'Fix submitted, waiting on the sensors' : 'Claimed, not fixed yet'}</div>
                </div>
                {w.status === 'claimed' && <button className="primary sm" disabled={busy} onClick={e => { e.stopPropagation(); me && markFixed({ warningId: w.id, techId: me.id }); }}>Mark fix done</button>}
              </div>
            ))}
          </div>
        )}

        <div className={`hero ${heroTone}`}>
          {top ? (
            <>
              <div className="hero-main">
                <div className="hero-eyebrow">{crit > 0 ? `${crit} rack${crit > 1 ? 's' : ''} critical` : 'Needs attention'}{others > 0 ? ` · ${others} more open` : ''}</div>
                <div className="hero-title">{top.rackId} · {kindOf(top.kind).title}</div>
                <div className="hero-sub">{whoLine}{etaTxt ? ` · critical in ${etaTxt}` : ''}{topInc?.tenants ? ` · ${topInc.tenants.split(', ')[0]}${topInc.tenants.includes(',') ? ` +${topInc.tenants.split(', ').length - 1} more` : ''} exposed` : ''}</div>
              </div>
              {burn > 0 && (
                <div className="hero-burn">
                  <div className="hero-burn-v">${Math.round(burn * 10).toLocaleString()}</div>
                  <div className="hero-burn-l">at risk per 10 min</div>
                </div>
              )}
              <div className="hero-act">
                {top.status === 'open' && topInc?.mode !== 'auto' && (
                  <button className="primary" disabled={busy} onClick={() => me && claimWarning({ warningId: top.id, techId: me.id })}>
                    {pagedMe ? 'Acknowledge' : `Claim as ${me?.name.split(' ')[0]}`}
                  </button>
                )}
                <button className="ghost" onClick={() => openWarning(top.id)}>Open incident</button>
              </div>
            </>
          ) : (
            <>
              <div className="hero-main">
                <div className="hero-eyebrow">All clear</div>
                <div className="hero-title">{racks.length} racks and {cdus.length} cooling units normal</div>
                <div className="hero-sub">Nemotron is watching every sensor. Break something below to see what happens.</div>
              </div>
              <div className="hero-act"><button className="ghost" onClick={() => setView('record')}>{records.length} signed records</button></div>
            </>
          )}
        </div>

        <div className="kpis">
          <div className="kpi amber">
            <div className="kpi-l">Time to owned</div>
            <div className="kpi-v">{ownedAvg ? `${ownedAvg}s` : '—'}</div>
            <div className="kpi-s">{ownedTimes.length ? `average over ${ownedTimes.length} incident${ownedTimes.length > 1 ? 's' : ''}` : 'alert until someone owns it'}</div>
          </div>
          <div className={`kpi ${escalated ? 'red' : 'green'}`}>
            <div className="kpi-l">Had to escalate</div>
            <div className="kpi-v">{escalated}<span className="kpi-of"> of {totalRaised}</span></div>
            <div className="kpi-s">{escalated ? (triedNoAnswer ? `${triedNoAnswer} tech${triedNoAnswer === 1 ? '' : 's'} not answering right now` : 'all cleared since') : 'everyone answered first time'}</div>
          </div>
          <div className="kpi violet">
            <div className="kpi-l">Caught before the limit</div>
            <div className="kpi-v">{beatLimit}<span className="kpi-of"> of {totalRaised}</span></div>
            <div className="kpi-s">flagged by Nemotron, not by a hard limit</div>
          </div>
          <div className="kpi green">
            <div className="kpi-l">Fixed without a tech</div>
            <div className="kpi-v">{agentFixes}</div>
            <div className="kpi-s">agent resolved it alone</div>
          </div>
        </div>

        <div className="roster">
          <span className="roster-l">{shift === 'night' ? 'Night' : 'Day'} shift</span>
          {roster.map(r => (
            <span key={r.t.id.toString()} className={`who-chip ${r.paged ? 'paged' : r.owns ? 'busy' : r.onShift ? 'free' : 'off'}`} title={`${r.t.role}${r.onShift ? '' : ' · off shift'}${r.missed ? ` · missed ${r.missed}` : ''}`}>
              <span className="who-dot" />{r.t.name.split(' ')[0]}
              <em>{r.paged ? `paged ${secsLeft(r.paged)}s` : r.owns ? `${r.owns} open` : r.onShift ? 'free' : 'on call'}</em>
            </span>
          ))}
          {pendingHandoffs.length > 0 && <button className="link roster-ho" onClick={() => setView('handoffs')}>{pendingHandoffs.length} handoff waiting to sign →</button>}
        </div>

        {roots.length > 0 && (
          <div className="panel queue">
            <div className="panel-head">
              <h3>What needs a visit <span className="count">{roots.length}</span></h3>
              <button className="link" onClick={() => setView('warnings')}>View all</button>
            </div>
            {byAisle.map(g => (
              <div key={g.aisle} className="aisle-group">
                <div className="aisle-head">Aisle {g.aisle}<span className="muted xxs"> · {g.items.length} stop{g.items.length > 1 ? 's' : ''} on this walk</span></div>
                {g.items.map(w => {
                  const i0 = incidentOf(w.id);
                  const k = KIT[w.kind] ?? KIT.reported;
                  const kids = w.kind === 'cdu' ? queue.filter(x => incidentOf(x.id)?.mode === 'symptom' && incidentOf(x.id)?.decision.includes(w.rackId)) : [];
                  return (
                    <div key={w.id.toString()}>
                      <div className={`q-row sev-${prio(w)}`} onClick={() => openWarning(w.id)}>
                        <div className="q-main">
                          <div className="q-title">
                            <b>{w.rackId}</b>
                            <span>{kindOf(w.kind).title}</span>
                            {w.source === 'agent' && <span className="q-tag">AI</span>}
                          </div>
                          <div className="q-meta">
                            <span className={`sev-text-${prio(w)}`}>{prio(w)}</span>
                            <span>{ago(w.createdAt)}</span>
                            <span>{w.claimedBy !== undefined ? nameOf(w.claimedBy) : routingLine(w.id) || 'Unassigned'}</span>
                            {w.status === 'fixing' && <span>Verifying fix</span>}
                          </div>
                          {(k.parts || k.hazard) && i0?.mode !== 'auto' && (
                            <div className="q-kit">
                              {k.parts && <span className="kit-parts">Bring: {k.parts}</span>}
                              {k.hazard && <span className="kit-haz">{k.hazard}</span>}
                            </div>
                          )}
                        </div>
                        {w.status === 'open' && i0?.mode === 'auto' && <span className="ai-tag">Agent fixing it</span>}
                        {w.status === 'open' && i0?.mode !== 'auto' && (
                          <button className="q-claim" disabled={busy} onClick={e => { e.stopPropagation(); if (me) claimWarning({ warningId: w.id, techId: me.id }); }}>
                            Claim
                          </button>
                        )}
                      </div>
                      {kids.length > 0 && (
                        <div className="q-kids" onClick={() => openWarning(kids[0].id)}>
                          <span className="q-kids-br" />
                          {kids.length} rack{kids.length > 1 ? 's' : ''} heating because of this ({kids.map(x => x.rackId).join(', ')}) · no separate page, clears when {w.rackId} is fixed
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <div className="two">
          <div className="panel">
            <div className="panel-head">
              <h3>Floor map</h3>
              <div className="row heat-key">
                <span className="muted xxs">68°F</span>
                <span className="heat-bar" />
                <span className="muted xxs">95°F</span>
                <button className="link" onClick={() => setView('racks')}>Rack detail</button>
              </div>
            </div>
            {['A', 'B', 'C'].map(aisle => {
              const c = cdus.find(x => x.aisle === aisle);
              const rs = sortedRacks.filter(r => r.aisle === aisle);
              return (
                <div key={aisle} className="aisle">
                  <div className="aisle-l">Aisle {aisle}</div>
                  <div className={`cdu-chip ${c && c.status !== 'ok' ? 'bad' : ''}`} title={c ? `${c.id}: ${c.flowLpm.toFixed(0)} L/min (normal ~120)` : ''}>
                    <span className="cdu-chip-n">{c?.flowLpm.toFixed(0) ?? '—'}</span>
                    <span className="cdu-chip-l">{c?.id ?? ''}</span>
                  </div>
                  <div className="aisle-racks">
                    {rs.map(r => {
                      const t0 = r.temperatureF;
                      const pct = Math.max(0, Math.min(1, (t0 - 68) / 27));
                      // Calm slate while normal, then it warms up and goes vivid red as it nears the limit.
                      const bg = r.status === 'down' ? 'hsl(0 70% 32%)' : `hsl(${Math.round(210 - pct * 210)} ${Math.round(12 + pct * pct * 78)}% ${Math.round(17 + pct * pct * 26)}%)`;
                      const tn = tenantOf(r.id);
                      return (
                        <div key={r.id} className={`heat ${r.status} ${r.pduAOnline && r.pduBOnline ? '' : 'nopower'}`} style={{ background: bg }} onClick={() => setView('racks')} title={`${r.id} · ${tn?.name ?? ''} · ${t0.toFixed(1)}°F`}>
                          <div className="heat-id">{r.id}</div>
                          <div className="heat-t">{r.status === 'down' ? 'OFF' : `${t0.toFixed(0)}°`}</div>
                          <div className="heat-tn">{r.pduAOnline && r.pduBOnline ? tn?.name.split(' ')[0] ?? '' : 'PDU down'}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <div className="row between floor-sum">
              <span className={crit ? 'red-text' : 'ok-text'}>{racks.length - crit - warn}/{racks.length} racks healthy</span>
              <span className={redundant < racks.length ? 'warn-text' : 'ok-text'}>{redundant}/{racks.length} on dual power</span>
              <span className={cdusOk < cdus.length ? 'red-text' : 'ok-text'}>{cdusOk}/{cdus.length} cooling units normal</span>
            </div>
          </div>
          <div className="side-col">
            <div className="panel">
              <div className="panel-head"><h3>Activity</h3><button className="link" onClick={() => setView('record')}>Full record</button></div>
              <div className="log">
                {sortedRecords.length === 0 && <p className="empty">Nothing signed yet.</p>}
                {sortedRecords.slice(0, 10).map(rec => (
                  <div key={rec.id.toString()} className="log-row">
                    <span className="log-time">{clock(rec.createdAt).replace(/:\d\d (?=[AP]M)/, ' ')}</span>
                    <span className="log-text">
                      <span className={`log-kind k-${rec.kind}`}>{REC_LABEL[rec.kind] ?? rec.kind}</span>
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

  // ─── verify an incident's timeline against Solana ───
  const [verify, setVerify] = useState<Record<string, { running: boolean; checks: Check[] }>>({});
  const verifyTimeline = async (warningId: bigint) => {
    const key = warningId.toString();
    setVerify(s => ({ ...s, [key]: { running: true, checks: [] } }));
    const recs = [...records].filter(r => r.refId === warningId && r.kind !== 'handoff' && r.txSignature).sort((a, b) => (a.id < b.id ? -1 : 1));
    const checks: Check[] = [];
    let prevLocal = '';
    for (const r of recs) {
      const local = await fingerprint(r);
      const link = links.find(l => l.recordId === r.id);
      try {
        const memo = await memoOf(r.txSignature);
        if (!memo) checks.push({ recordId: r.id.toString(), ok: false, note: 'transaction not found' });
        else if (memo.sha256 !== local) checks.push({ recordId: r.id.toString(), ok: false, note: 'record was changed after it was signed' });
        else if (link && (memo.prev ?? '') !== prevLocal) checks.push({ recordId: r.id.toString(), ok: false, note: 'an earlier event is missing or was changed' });
        else checks.push({ recordId: r.id.toString(), ok: true, note: link ? 'linked' : 'matches (older record, no link)' });
      } catch {
        checks.push({ recordId: r.id.toString(), ok: false, note: 'could not reach Solana' });
      }
      if (link) prevLocal = local;
      await new Promise(res => setTimeout(res, 250)); // be gentle with the free devnet server
    }
    setVerify(s => ({ ...s, [key]: { running: false, checks } }));
  };
  // A shared link (?incident=ID) opens that incident.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('incident');
    if (id) { setSelectedId(BigInt(id)); setView('warnings'); }
  }, []);

  // ─── incident log: everything that happened, in order ───
  const incidentLog = (w: (typeof allWarnings)[number]) => {
    const ms = (ts?: Micros) => (ts ? toDate(ts).getTime() : 0);
    const chain = pagesOf(w.id);
    const an = analysisOf(w.id);
    const ev: { t: number; who: string; text: string; tone: string; tx?: string }[] = [];
    const src = w.source === 'agent' ? 'Nemotron agent' : w.source === 'tech' ? nameOf(w.reportedBy) : 'Sensor rule';
    ev.push({ t: ms(w.createdAt), who: src, text: `raised the alert: ${w.message}`, tone: 'red' });
    // Signed records for this incident, matched to page events in order (k-th "paged" record = k-th page sent).
    const recsOf = (kind: string) => [...records].filter(r => r.refId === w.id && r.kind === kind).sort((a, b) => (a.id < b.id ? -1 : 1));
    const pagedRecs = recsOf('paged'), missedRecs = recsOf('page_missed'), declinedRecs = recsOf('page_declined'), heldRecs = recsOf('page_held');
    let np = 0, nm = 0, nd = 0, nh = 0;
    // Include superseded holds too, so the log shows the full story.
    const allPages = [...pages].filter(p => p.warningId === w.id).sort((a, b) => (a.id < b.id ? -1 : 1));
    allPages.forEach(p => {
      const sent = allPages.filter(o => o.timeoutSec > 0);
      const next = sent[sent.indexOf(p) + 1];
      if (p.timeoutSec === 0) {
        ev.push({ t: ms(p.pagedAt), who: 'Night Watch', text: `held it for ${nameOf(p.techId)} instead of paging now (${p.reason})`, tone: 'blue', tx: heldRecs[nh++]?.txSignature });
        return;
      }
      ev.push({ t: ms(p.pagedAt), who: 'Night Watch', text: `paged ${nameOf(p.techId)} (${p.reason}), ${p.timeoutSec}s to respond`, tone: 'amber', tx: pagedRecs[np++]?.txSignature });
      const end = next ? ms(next.pagedAt) : ms(p.pagedAt) + p.timeoutSec * 1000;
      if (p.status === 'missed') ev.push({ t: end - 1, who: nameOf(p.techId), text: `didn't respond in ${p.timeoutSec}s, so it escalated`, tone: 'red', tx: missedRecs[nm++]?.txSignature });
      if (p.status === 'declined') ev.push({ t: end - 1, who: nameOf(p.techId), text: `said they can't take it, so it escalated`, tone: 'red', tx: declinedRecs[nd++]?.txSignature });
      if (p.status === 'acknowledged' && p.ackAt) ev.push({ t: ms(p.ackAt), who: nameOf(p.techId), text: `acknowledged the page`, tone: 'green' });
    });
    if (an) ev.push({ t: ms(an.createdAt), who: 'Nemotron', text: `root cause (${an.confidence}% confident): ${an.rootCause}. ${an.runbook}`, tone: 'blue' });
    if (w.claimedAt && !chain.some(p => p.status === 'acknowledged' && p.techId === w.claimedBy))
      ev.push({ t: ms(w.claimedAt), who: nameOf(w.claimedBy), text: `claimed it from the dashboard`, tone: 'green' });
    const recs = [...records].filter(r => r.refId === w.id && (r.kind === 'claim' || r.kind === 'fix_verified'));
    for (const r of [...records].filter(r0 => r0.refId === w.id && r0.kind === 'agent_action'))
      ev.push({ t: ms(r.createdAt), who: 'Nemotron agent', text: r.summary.replace(/^Nemotron agent /, ''), tone: 'blue', tx: r.txSignature });
    for (const r of recs) ev.push({ t: ms(r.createdAt) + (r.kind === 'claim' ? 1 : 0), who: r.kind === 'claim' ? 'Signed record' : 'Sensor data', text: r.kind === 'claim' ? `ownership signed: ${r.summary}` : r.summary, tone: r.kind === 'claim' ? 'gray' : 'green', tx: r.txSignature });
    if (w.status === 'resolved' && !recs.some(r => r.kind === 'fix_verified')) ev.push({ t: ms(w.resolvedAt), who: 'Night Watch', text: 'marked resolved', tone: 'green' });
    ev.sort((a, b) => a.t - b.t);
    const total = w.resolvedAt ? Math.round((ms(w.resolvedAt) - ms(w.createdAt)) / 1000) : undefined;
    const ackSecs = w.claimedAt ? Math.round((ms(w.claimedAt) - ms(w.createdAt)) / 1000) : undefined;
    const dur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
    const key = w.id.toString();
    const v = verify[key];
    const onChain = [...records].filter(r => r.refId === w.id && r.kind !== 'handoff' && r.txSignature).length;
    return (
      <div className="panel">
        <div className="panel-head">
          <h3>Incident log</h3>
          <div className="row">
            <span className="muted xxs">{ackSecs !== undefined ? `owned after ${dur(ackSecs)}` : 'not owned yet'}{total !== undefined ? ` · resolved in ${dur(total)}` : ''}</span>
            {onChain > 0 && <button className="ghost sm" disabled={v?.running} onClick={() => void verifyTimeline(w.id)}>{v?.running ? 'Checking Solana…' : 'Verify timeline'}</button>}
            {onChain > 0 && <button className="ghost sm" onClick={() => void navigator.clipboard?.writeText(`${location.origin}${location.pathname}?incident=${key}`)} title="Link that opens this incident's verifiable timeline">Copy link</button>}
          </div>
        </div>
        {v && !v.running && (
          <div className={`callout ${v.checks.every(c => c.ok) ? 'green' : 'red'} xs`}>
            {v.checks.every(c => c.ok)
              ? `✓ Timeline intact: ${v.checks.length} record${v.checks.length > 1 ? 's' : ''} match Solana devnet, each linked to the one before it. Nothing was deleted or changed.`
              : `✗ ${v.checks.filter(c => !c.ok).length} record(s) don't match Solana: ${v.checks.filter(c => !c.ok).map(c => `#${c.recordId} ${c.note}`).join('; ')}`}
          </div>
        )}
        <div className="ilog">
          {ev.map((e, i) => (
            <div key={i} className="ilog-row">
              <span className="log-time">{e.t ? new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}</span>
              <span className={`ilog-dot ${e.tone}`} />
              <span className="xs"><b>{e.who}</b> {e.text}
                {e.tx !== undefined && (e.tx
                  ? <> · <a className="chain-link" href={`https://explorer.solana.com/tx/${e.tx}?cluster=devnet`} target="_blank" rel="noreferrer">on-chain ↗</a></>
                  : <span className="muted"> · on-chain pending</span>)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ─── incident page: summary strip, one action, then tabs ───
  const [incTab, setIncTab] = useState<'overview' | 'impact' | 'routing' | 'log'>('overview');

  const Warnings = () => {
    const w = selected;
    const steps = w ? [...tasks].filter(t0 => t0.warningId === w.id).sort((a, b) => a.stepNumber - b.stepNumber) : [];
    const rack = w ? racks.find(r => r.id === w.rackId) : undefined;
    const mine = !!(w && me && w.claimedBy === me.id);
    const reported = w?.kind === 'reported';
    const km = w ? kindOf(w.kind) : undefined;
    const inc = w ? incidentOf(w.id) : undefined;
    const an = w ? analysisOf(w.id) : undefined;
    const chain = w ? pagesOf(w.id) : [];
    const live = chain.find(p => p.status === 'paging' || p.status === 'queued');
    const myPage = !!(me && live && live.status === 'paging' && live.techId === me.id);
    const prio = inc?.priority ?? w?.severity ?? 'medium';
    const eta = inc?.minutesToCritical ?? -1;
    const done = w?.status === 'resolved';
    const agentFixed = !!w && w.kind === 'power' && w.claimedBy === undefined && (w.status === 'fixing' || w.status === 'resolved');
    const agentWorking = !!w && w.kind === 'power' && w.status === 'open' && inc?.mode === 'auto';
    const tenantRows = (inc?.tenants ?? '').split(', ').filter(Boolean).map(n => {
      const tn = tenants.find(x => x.name === n);
      return { name: n, tn, sig: tn ? signals.find(sg => sg.tenantId === tn.id) : undefined };
    });
    const verifyRule = !w || !km ? '' : reported ? 'A second tech must confirm the fix'
      : w.kind === 'cdu' ? 'Clears when flow is above 105 L/min and pressure above 190 kPa'
      : w.kind === 'pdu' ? 'Clears when both PDU feeds are back online'
      : `Clears when ${km.label.toLowerCase()} is under ${km.ok}${km.unit}`;
    const reading = !w ? '' : w.kind === 'cdu'
      ? (() => { const c = cdus.find(x => x.id === w.rackId); return c ? `${c.flowLpm.toFixed(0)} L/min · ${c.pressureKpa.toFixed(0)} kPa` : ''; })()
      : w.kind === 'pdu' ? (rack ? `PDU A ${pduText(rack.pduAOnline, rack.pduALoadPct)} · B ${pduText(rack.pduBOnline, rack.pduBLoadPct)}` : '')
      : reported ? '' : fmt(w.kind, rack);
    const etaTxt = eta === 0 ? 'Now' : eta > 0 ? (eta < 1 ? `${Math.max(5, Math.round((eta * 60) / 5) * 5)} s` : `${Math.round(eta)} min`) : 'No deadline';

    const action = () => {
      if (!w) return null;
      if (agentFixed) return <span className="green-text xs">{w.status === 'resolved' ? '✓ Fixed by the Nemotron agent and verified by sensors. Nobody was paged.' : 'The Nemotron agent fixed this itself. Waiting for the sensors to confirm…'}</span>;
      if (agentWorking) return <span className="muted xs">The Nemotron agent is fixing this itself. A tech is paged only if that doesn't work.</span>;
      if (w.status === 'open') return (
        <>
          <button className="primary" disabled={busy} onClick={() => me && claimWarning({ warningId: w.id, techId: me.id })}>{myPage ? 'Acknowledge page' : `Claim as ${me?.name.split(' ')[0]}`}</button>
          {myPage && <button className="ghost" disabled={busy} onClick={() => me && declinePage({ warningId: w.id, techId: me.id })}>Can't take it</button>}
        </>
      );
      if (w.status === 'claimed') return mine
        ? <button className="primary" disabled={busy} onClick={() => me && markFixed({ warningId: w.id, techId: me.id })}>Mark fix done</button>
        : <span className="muted xs">{nameOf(w.claimedBy)} owns this. Only they can mark it fixed.</span>;
      if (w.status === 'fixing') return reported
        ? (me && w.claimedBy !== me.id
          ? <button className="primary" disabled={busy} onClick={() => verifyFix({ warningId: w.id, techId: me.id })}>Verify fix as {me.name.split(' ')[0]}</button>
          : <span className="muted xs">Waiting for another tech to verify.</span>)
        : <span className="muted xs">Fix submitted. Watching sensor data to confirm…</span>;
      return <span className="green-text xs">✓ Fixed, verified and signed</span>;
    };

    const tabs: { id: typeof incTab; label: string; n?: number }[] = [
      { id: 'overview', label: 'What to do' },
      { id: 'impact', label: 'Impact' },
      { id: 'routing', label: 'Who & why', n: chain.length || undefined },
      { id: 'log', label: 'Log' },
    ];

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
          {filtered.map(x => {
            const p = incidentOf(x.id)?.priority ?? x.severity;
            const route = x.status === 'open' ? routingLine(x.id) : '';
            const byAgent = x.kind === 'power' && x.claimedBy === undefined && x.status !== 'open';
            return (
              <button key={x.id.toString()} className={`list-item li-${x.status === 'resolved' ? 'done' : p} ${w?.id === x.id ? 'sel' : ''}`} onClick={() => setSelectedId(x.id)}>
                <div className="row between"><b>{x.rackId} · {kindOf(x.kind).title}</b>{x.source === 'agent' && <span className="ai-tag">AI</span>}</div>
                <div className="row between xs">
                  <span className="muted">{route || (byAgent ? 'Nemotron agent' : x.claimedBy !== undefined ? nameOf(x.claimedBy) : 'Unassigned')} · {ago(x.createdAt)}</span>
                  <Chip v={x.status} label={x.status === 'open' ? 'unclaimed' : x.status} />
                </div>
              </button>
            );
          })}
        </div>

        <div className="detail-pane">
          {reportForm()}
          {!w || !km ? <p className="empty">Select a warning.</p> : (
            <>
              <div className="inc-head">
                <div>
                  <div className="row"><Chip v={done ? 'resolved' : prio} label={done ? 'resolved' : `${prio} priority`} />{w.source === 'agent' && <span className="ai-tag">Caught early by Nemotron</span>}</div>
                  <h1>{w.rackId} · {km.title}</h1>
                  <p className="muted xs">{w.message}</p>
                </div>
                {me?.role === 'supervisor' && inc && !done && (
                  <select className="fault-pick" value="" onChange={e => e.target.value && overridePriority({ warningId: w.id, techId: me.id, priority: e.target.value })}>
                    <option value="">override priority ▾</option>
                    {['critical', 'medium', 'low'].map(p => <option key={p} value={p}>Set {p}</option>)}
                  </select>
                )}
              </div>

              <div className={`strip ${done ? 'done' : ''}`}>
                <div className={`cell ${!done && eta >= 0 && eta <= 10 ? 'bad' : ''}`}>
                  <div className="cell-l">Time to critical</div>
                  <div className="cell-v">{done ? '—' : etaTxt}</div>
                  <div className="cell-s">{reading || (done ? 'resolved' : '')}</div>
                </div>
                <div className={`cell ${!done && inc?.slaAtRisk ? 'warn' : ''}`}>
                  <div className="cell-l">Cost if down</div>
                  <div className="cell-v">{inc?.costPerMinute ? `$${Math.round(inc.costPerMinute * 10).toLocaleString()}` : '—'}</div>
                  <div className="cell-s">per 10 min{inc?.slaAtRisk ? ' · SLA at risk' : ''}</div>
                </div>
                <div className="cell">
                  <div className="cell-l">Exposed</div>
                  <div className="cell-v">{inc ? inc.affectedRacks.split(', ').filter(Boolean).length : 1} rack{inc && inc.affectedRacks.includes(',') ? 's' : ''}</div>
                  <div className="cell-s">{tenantRows.length ? `${tenantRows.length} tenant${tenantRows.length > 1 ? 's' : ''}` : inc?.affectedRacks ?? w.rackId}</div>
                </div>
                <div className={`cell ${w.status === 'open' && !agentWorking ? 'bad' : ''}`}>
                  <div className="cell-l">{agentFixed || agentWorking ? 'Handled by' : w.claimedBy !== undefined ? 'Owner' : live?.status === 'queued' ? 'Holding for' : live ? 'Paging' : 'Owner'}</div>
                  <div className="cell-v sm">{agentFixed || agentWorking ? 'Nemotron agent' : w.claimedBy !== undefined ? nameOf(w.claimedBy) : live ? nameOf(live.techId) : 'Nobody'}</div>
                  <div className="cell-s">{agentFixed ? 'nobody paged' : agentWorking ? 'fixing it now' : w.claimedBy !== undefined ? `took it after ${Math.round((toDate(w.claimedAt!).getTime() - toDate(w.createdAt).getTime()) / 1000)}s` : live?.status === 'paging' ? `escalates in ${secsLeft(live)}s` : live ? 'next shift' : ago(w.createdAt)}</div>
                </div>
              </div>

              <div className="actions">{action()}</div>
              {inc?.bumpReason && !done && <div className="bump xs"><b>Priority raised:</b> {inc.bumpReason.replace(/^Raised \w+ to \w+: /, '')}</div>}

              <div className="tabs inc-tabs">
                {tabs.map(t0 => <button key={t0.id} className={incTab === t0.id ? 'tab on' : 'tab'} onClick={() => setIncTab(t0.id)}>{t0.label}{t0.n ? <span className="count">{t0.n}</span> : null}</button>)}
              </div>

              {incTab === 'overview' && (
                <>
                  <div className="panel ai-card">
                    <div className="panel-head"><h3><span className="ai-dot" />Nemotron analysis</h3>{an && <span className="muted xxs">{an.confidence}% confident</span>}</div>
                    {an ? (
                      <>
                        {an.callSenior && <div className="callout red xs">Low confidence: call a senior tech before acting on this.</div>}
                        <p className="root">{an.rootCause}</p>
                        <div className="conf"><div style={{ width: `${an.confidence}%` }} className={an.confidence < 60 ? 'low' : ''} /></div>
                        <div className="kv xs"><span>Runbook</span><span>{an.runbook}</span></div>
                        {inc?.similarFix && <div className="kv xs"><span>Done before</span><span>{inc.similarFix}</span></div>}
                        {an.evidence && <details className="xs"><summary>Evidence from the sensors</summary><p className="muted">{an.evidence.split(' · ').map((e0, i) => <span key={i} className="ev">{e0}</span>)}</p></details>}
                      </>
                    ) : inc?.mode === 'symptom'
                      ? <p className="muted xs">{inc.decision}</p>
                      : <p className="empty">Nemotron is reading the sensor trail…</p>}
                  </div>

                  <div className="panel">
                    <div className="panel-head"><h3>Fix steps</h3><span className="muted xxs">{verifyRule}</span></div>
                    {steps.length === 0 ? <p className="empty">The plan will appear here.</p> : (
                      <div className="checklist">
                        {steps.map(s0 => (
                          <div key={s0.id.toString()} className={`check ${s0.status === 'done' ? 'on' : ''}`}>
                            <span className="box">{s0.status === 'done' ? '✓' : ''}</span>
                            <div className="grow">
                              <div className="xs">{s0.description}</div>
                              {s0.result && s0.executor === 'agent' && <div className="faint xxs clamp">{s0.result}</div>}
                            </div>
                            <span className={`who ${s0.executor}`}>{s0.executor === 'agent' ? 'Agent' : 'Tech'}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {incTab === 'impact' && (
                <div className="panel">
                  {inc ? (
                    <>
                      <p className="xs">{inc.ifUnfixed}</p>
                      <div className="kv xs"><span>Racks</span><span>{inc.affectedRacks}</span></div>
                      {tenantRows.length > 0 && (
                        <table className="tenants">
                          <thead><tr><th>Tenant</th><th>Tier</th><th>SLA</th><th>Right now</th></tr></thead>
                          <tbody>
                            {tenantRows.map(r => (
                              <tr key={r.name}>
                                <td><b>{r.name}</b><div className="faint xxs">{r.tn?.workload}</div></td>
                                <td>{r.tn?.tier}</td>
                                <td>{r.tn ? `${r.tn.slaPct}%` : ''}</td>
                                <td className="xs">
                                  {r.sig?.url
                                    ? <><span className={`news-score s${r.sig.score}`}>{['normal', 'watch', 'hot'][r.sig.score]}</span> <a className="chain-link" href={r.sig.url} target="_blank" rel="noreferrer">{r.sig.headline}</a> <span className="faint">via {r.sig.company}</span></>
                                    : r.tn?.flagNote ? <span className="warn-text">{r.tn.flagNote}</span> : <span className="faint">nothing flagged</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      <p className="faint xxs">Sample tenants and assumed downtime rates. Headlines are real news about stand-in companies, not NMC² customers, scored by Nemotron.</p>
                    </>
                  ) : <p className="empty">No impact data for this one.</p>}
                </div>
              )}

              {incTab === 'routing' && (
                <div className="panel">
                  {inc && <div className="row between" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>Routing decision</h3><Chip v={inc.mode} label={MODE_LABEL[inc.mode] ?? inc.mode} /></div>}
                  {inc?.decision && <p className="xs">{inc.decision}</p>}
                  {chain.length === 0 ? <p className="empty">{agentFixed || agentWorking ? 'Nobody was paged: the Nemotron agent handled it.' : 'Nobody has been paged for this.'}</p> : (
                    <div className="pages">
                      {chain.map((p, i) => {
                        const t0 = techs.find(x => x.id === p.techId);
                        return (
                          <div key={p.id.toString()} className={`page-row ${p.status}`}>
                            <span className="step-n">{i + 1}</span>
                            <div className="avatar sm">{initials(nameOf(p.techId))}</div>
                            <div className="grow">
                              <div className="xs"><b>{nameOf(p.techId)}</b> <span className="muted">· {t0?.role} · {t0?.shift} shift</span></div>
                              <div className="muted xxs">{p.reason}</div>
                            </div>
                            <Chip v={p.status} label={pageLabel(p)} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {incTab === 'log' && incidentLog(w)}
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
      <div className="rack-grid big">{sortedCdus.map(c => cduCard(c, true))}</div>
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
      <div className="page-head"><div><h1>Signed record</h1><p className="muted">Pages, missed pages, claims, verified fixes and handoffs. Each one is signed by the techs involved and written to Solana devnet, so nobody can change it later. Click a signature to see it on the Solana explorer.</p></div></div>
      <div className="panel">
        <table>
          <thead><tr><th>Time</th><th>Event</th><th>Who</th><th>Details</th><th>Chain</th></tr></thead>
          <tbody>
            {sortedRecords.map(rec => (
              <tr key={rec.id.toString()}>
                <td className="muted">{clock(rec.createdAt)}</td>
                <td><Chip v={REC_TONE[rec.kind] ?? 'gray'} label={REC_LABEL[rec.kind] ?? rec.kind} /></td>
                <td>{rec.techIds.map(id => nameOf(id)).join(' + ') || 'Night Watch'}</td>
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
          <label className="row xs muted">On shift
            <select className="fault-pick" value={shift} disabled={!connected} onChange={e => setShift({ shift: e.target.value })}>
              <option value="night">Night</option>
              <option value="day">Day</option>
            </select>
          </label>
          <button className="link xs" onClick={() => resetDemo()} disabled={!connected}>Reset demo data</button>
          <div className="me">
            <div className="avatar">{me ? initials(me.name) : '?'}</div>
            <div className="me-info">
              <select value={actingId} onChange={e => setActingId(e.target.value)}>
                {techs.map(x => <option key={x.id.toString()} value={x.id.toString()}>{x.name}{pages.some(p => p.techId === x.id && p.status === 'paging') ? ' (paged)' : ''}</option>)}
              </select>
              <div className="muted xxs">{me ? `${me.role} · ${me.shift} shift` : ''}</div>
              {me?.walletPubkey && <div className="muted xxs mono" title={me.walletPubkey}>{me.walletPubkey.slice(0, 4)}…{me.walletPubkey.slice(-4)}</div>}
            </div>
          </div>
        </div>
      </aside>
      <main>
        {myPages.map(p => {
          const w = warnings.find(x => x.id === p.warningId);
          if (!w || w.status !== 'open') return null;
          if (view === 'overview') return null; // 'On you right now' covers it
          if (view === 'warnings' && selected?.id === w.id) return null; // the incident page already has the button
          return (
            <div key={p.id.toString()} className="paged-banner">
              <div className="grow">
                <b>You're being paged: {w.rackId} · {kindOf(w.kind).title}</b>
                <div className="xs">{incidentOf(w.id)?.ifUnfixed ?? w.message} Escalates in {secsLeft(p)}s if you don't respond.</div>
              </div>
              <button className="ghost sm" onClick={() => openWarning(w.id)}>Details</button>
              <button className="ghost sm" disabled={busy} onClick={() => me && declinePage({ warningId: w.id, techId: me.id })}>Can't take it</button>
              <button className="primary sm" disabled={busy} onClick={() => me && claimWarning({ warningId: w.id, techId: me.id })}>Acknowledge</button>
            </div>
          );
        })}
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
    --violet:#a78bfa; --cyan:#22d3ee; --pink:#f472b6;
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
  .inc-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:14px; }
  .inc-head h1 { margin:8px 0 2px; font-size:22px; }
  .ai-tag { font-size:10.5px; font-weight:600; color:var(--info); border:1px solid rgba(106,161,255,.4); border-radius:4px; padding:1px 6px; }
  .strip { display:grid; grid-template-columns:repeat(4,1fr); border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--line); gap:1px; }
  .strip .cell { background:var(--panel); padding:12px 16px; }
  .strip .cell.bad { box-shadow:inset 0 3px 0 var(--bad); }
  .strip .cell.warn { box-shadow:inset 0 3px 0 var(--warn); }
  .strip.done .cell { opacity:.75; }
  .cell-l { font-size:11.5px; color:var(--muted); }
  .cell-v { font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; letter-spacing:-.01em; margin-top:2px; }
  .cell-v.sm { font-size:17px; padding:3px 0 2px; }
  .cell-s { font-size:11.5px; color:var(--faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .actions { margin:14px 0 8px; }
  .bump { color:var(--warn); border-left:2px solid var(--warn); padding:4px 10px; margin:0 0 6px; }
  .inc-tabs { margin:14px 0 14px; }
  .inc-tabs .count { margin-left:6px; }
  .ai-card { border-color:rgba(106,161,255,.3); }
  .ai-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--info); margin-right:8px; vertical-align:1px; }
  .root { font-size:15px; font-weight:600; margin:2px 0 8px; line-height:1.45; }
  .kv { display:grid; grid-template-columns:96px 1fr; gap:10px; padding:7px 0; border-top:1px solid var(--line); }
  .kv > span:first-child { color:var(--muted); }
  details { margin-top:8px; } summary { cursor:pointer; color:var(--muted); } summary:hover { color:var(--text); }
  .ev { display:block; padding:3px 0 3px 10px; border-left:2px solid var(--line2); margin:4px 0; }
  .checklist { display:flex; flex-direction:column; gap:2px; }
  .check { display:flex; gap:10px; align-items:flex-start; padding:8px 4px; border-bottom:1px solid var(--line); }
  .check:last-child { border-bottom:0; }
  .check .box { width:18px; height:18px; border-radius:4px; border:1.5px solid var(--line2); display:grid; place-items:center; font-size:11px; flex-shrink:0; margin-top:1px; }
  .check.on .box { background:var(--ok); border-color:var(--ok); color:#0b0d10; font-weight:700; }
  .check.on .xs { color:var(--muted); }
  .who { font-size:10.5px; font-weight:600; border-radius:4px; padding:1px 6px; border:1px solid var(--line2); color:var(--muted); flex-shrink:0; }
  .who.agent { color:var(--info); border-color:rgba(106,161,255,.4); }
  .step-n { width:18px; text-align:center; color:var(--faint); font-size:12px; font-variant-numeric:tabular-nums; }
  table.tenants { margin:10px 0 6px; } table.tenants td { vertical-align:top; }
  .warn-text { color:var(--warn); }
  .list-item { border-left:3px solid transparent; }
  .list-item.li-critical { border-left-color:var(--bad); } .list-item.li-medium { border-left-color:var(--warn); } .list-item.li-low { border-left-color:var(--info); } .list-item.li-done { border-left-color:var(--line2); opacity:.7; }
  .incident { max-width:880px; }
  .progress { display:grid; grid-template-columns:repeat(4,1fr); gap:0; margin:6px 0 4px; border:1px solid var(--line); border-radius:10px; background:var(--panel); overflow:hidden; }
  .pg { display:flex; gap:10px; align-items:flex-start; padding:12px 14px; border-right:1px solid var(--line); }
  .pg:last-child { border-right:0; }
  .pg-dot { width:22px; height:22px; border-radius:50%; border:2px solid var(--line2); display:grid; place-items:center; font-size:11px; font-weight:700; color:var(--faint); flex-shrink:0; }
  .pg.done .pg-dot { background:var(--ok); border-color:var(--ok); color:#0b0d10; }
  .pg.cur .pg-dot { border-color:var(--accent); color:var(--accent); }
  .pg-l { font-weight:600; font-size:12.5px; }
  .pg:not(.done):not(.cur) .pg-l { color:var(--muted); }
  .pg-s { font-size:11.5px; color:var(--muted); }
  .sec { margin-top:30px; }
  .sec h2 { font-size:15px; font-weight:600; margin:0 0 10px; display:flex; align-items:center; gap:10px; letter-spacing:-.01em; }
  .sec-n { width:22px; height:22px; border-radius:6px; background:var(--panel2); border:1px solid var(--line2); display:grid; place-items:center; font-size:12px; color:var(--muted); }
  .story { font-size:14.5px; line-height:1.65; margin:0 0 14px; max-width:760px; }
  .charts { display:grid; gap:12px; }
  .charts.n2 { grid-template-columns:1fr 1fr; }
  .chart { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px 10px; }
  .chart-title { font-size:12px; color:var(--muted); margin-bottom:8px; }
  .chart-box { position:relative; }
  .mark-l { position:absolute; left:4px; font-size:10.5px; font-weight:600; background:var(--panel); padding:0 4px; border-radius:3px; }
  .chart-foot > .faint { white-space:nowrap; }
  .chart-foot { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:6px; font-size:11px; }
  .legend { display:flex; gap:12px; flex-wrap:wrap; justify-content:center; color:var(--muted); }
  .legend i { display:inline-block; width:10px; height:3px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  .legend b { color:var(--text); font-variant-numeric:tabular-nums; }
  .chart-empty { color:var(--faint); font-size:12px; padding:30px 0; text-align:center; }
  .cause { display:flex; flex-wrap:wrap; align-items:stretch; gap:6px; margin-bottom:16px; }
  .cause-step { display:flex; align-items:center; gap:6px; }
  .cause-arrow { color:var(--faint); font-size:16px; }
  .cause-node { border:1px solid var(--line2); border-left-width:3px; border-radius:8px; padding:8px 12px; background:var(--panel); min-width:130px; }
  .cause-node.red { border-left-color:var(--bad); } .cause-node.amber { border-left-color:var(--warn); } .cause-node.green { border-left-color:var(--ok); }
  .cn-l { font-weight:600; font-size:12.5px; }
  .cn-s { font-size:11px; color:var(--muted); }
  .checks { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .checks-head { margin-bottom:6px; }
  .chk { display:flex; gap:10px; align-items:baseline; padding:6px 0; border-top:1px solid var(--line); }
  .chk-i { width:16px; font-weight:700; flex-shrink:0; }
  .chk.ok .chk-i { color:var(--ok); } .chk.no .chk-i { color:var(--bad); } .chk.no .xs { color:var(--muted); }
  .conf-chip { font-size:11px; font-weight:600; border-radius:999px; padding:2px 10px; border:1px solid; }
  .conf-chip.high { color:var(--ok); border-color:rgba(63,178,127,.45); }
  .conf-chip.medium { color:var(--warn); border-color:rgba(224,164,58,.45); }
  .conf-chip.low { color:var(--bad); border-color:rgba(229,83,75,.5); }
  .plan { list-style:none; margin:8px 0 0; padding:0; display:flex; flex-direction:column; gap:6px; }
  .plan li { display:flex; gap:12px; align-items:flex-start; border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:var(--panel); }
  .plan li.now { border-color:var(--accent); box-shadow:inset 3px 0 0 var(--accent); }
  .plan li.on { opacity:.7; }
  .plan-box { width:22px; height:22px; border-radius:6px; border:1.5px solid var(--line2); display:grid; place-items:center; font-size:11.5px; font-weight:700; color:var(--muted); flex-shrink:0; }
  .plan li.on .plan-box { background:var(--ok); border-color:var(--ok); color:#0b0d10; }
  .plan li.now .plan-box { border-color:var(--accent); color:var(--accent); }
  .plan-t { font-size:13.5px; }
  .plan-r { font-size:12px; color:var(--muted); margin-top:3px; }
  .details { border-top:1px solid var(--line); padding-top:6px; }
  .details .strip { grid-template-columns:repeat(3,1fr); margin-bottom:6px; }
  .hero { display:flex; align-items:center; gap:20px; border:1px solid var(--line2); border-radius:12px; padding:18px 22px; margin-bottom:16px; background:var(--panel); position:relative; overflow:hidden; }
  .hero::before { content:''; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--faint); }
  .hero.bad::before { background:var(--bad); } .hero.warn::before { background:var(--warn); } .hero.ok::before { background:var(--ok); }
  .hero.bad { border-color:rgba(229,83,75,.45); background:linear-gradient(90deg, rgba(229,83,75,.09), transparent 42%), var(--panel); }
  .hero.warn { border-color:rgba(224,164,58,.4); background:linear-gradient(90deg, rgba(224,164,58,.08), transparent 42%), var(--panel); }
  .hero.ok { border-color:rgba(63,178,127,.35); }
  .hero-main { flex:1; min-width:0; }
  .hero-eyebrow { font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .hero.bad .hero-eyebrow { color:var(--bad); } .hero.warn .hero-eyebrow { color:var(--warn); } .hero.ok .hero-eyebrow { color:var(--ok); }
  .hero-title { font-size:23px; font-weight:600; letter-spacing:-.02em; margin:3px 0 4px; }
  .hero-sub { font-size:13px; color:var(--muted); }
  .hero-burn { text-align:right; padding-right:20px; border-right:1px solid var(--line); flex-shrink:0; }
  .hero-burn-v { font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; letter-spacing:-.01em; }
  .hero.bad .hero-burn-v { color:var(--bad); }
  .hero-burn-l { font-size:11px; color:var(--muted); }
  .hero-act { display:flex; gap:8px; flex-shrink:0; }
  .hero-act .ghost, .hero-act .primary { padding:9px 14px; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--faint); } .dot.ok { background:var(--ok); opacity:.65; }
  .rack-grid { grid-template-columns:repeat(auto-fill,minmax(148px,1fr)); }
  .rack .spark { margin:4px 0 6px; }
  .rack-temp { margin:6px 0 0; }
  .tile-foot { display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-size:11px; }
  .tile-foot > span:first-child { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .rack.big .tile-foot { margin-top:6px; }
  .floor-sum { gap:14px; font-size:11.5px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .floor-sum span + span::before { content:'·'; margin-right:14px; color:var(--line2); }
  .warn-text { color:var(--warn); }
  .q-row.sub { margin-left:18px; opacity:.72; border-left-width:2px; }
  .q-row.sub .q-title b { font-weight:500; }
  .fault-pick { max-width:74px; opacity:.55; }
  .fault-pick:hover { opacity:1; }
  .rack.big .fault-pick { max-width:120px; }
  .q-kids { display:flex; align-items:center; gap:8px; font-size:11.5px; color:var(--faint); margin:-2px 0 6px 14px; padding:5px 10px; cursor:pointer; }
  .q-kids:hover { color:var(--muted); }
  .q-kids-br { width:12px; height:8px; border-left:1px solid var(--line2); border-bottom:1px solid var(--line2); border-bottom-left-radius:4px; margin-top:-8px; flex-shrink:0; }
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px; }
  .kpi { border-radius:10px; padding:13px 16px; border:1px solid; position:relative; overflow:hidden; }
  .kpi::after { content:''; position:absolute; right:-18px; top:-18px; width:66px; height:66px; border-radius:50%; opacity:.1; }
  .kpi-l { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
  .kpi-v { font-size:27px; font-weight:600; letter-spacing:-.02em; font-variant-numeric:tabular-nums; margin:2px 0 1px; color:var(--text); }
  .kpi-s { font-size:11.5px; color:var(--muted); }
  .kpi.violet { border-color:rgba(167,139,250,.35); background:linear-gradient(160deg, rgba(167,139,250,.14), rgba(167,139,250,.03)); }
  .kpi.violet .kpi-l { color:var(--violet); } .kpi.violet::after { background:var(--violet); }
  .kpi.green { border-color:rgba(63,178,127,.35); background:linear-gradient(160deg, rgba(63,178,127,.14), rgba(63,178,127,.03)); }
  .kpi.green .kpi-l { color:var(--ok); } .kpi.green::after { background:var(--ok); }
  .kpi.amber { border-color:rgba(224,164,58,.35); background:linear-gradient(160deg, rgba(224,164,58,.14), rgba(224,164,58,.03)); }
  .kpi.amber .kpi-l { color:var(--warn); } .kpi.amber::after { background:var(--warn); }
  .kpi.cyan { border-color:rgba(34,211,238,.32); background:linear-gradient(160deg, rgba(34,211,238,.13), rgba(34,211,238,.03)); }
  .kpi.cyan .kpi-l { color:var(--cyan); } .kpi.cyan::after { background:var(--cyan); }

  .onme { border:1px solid rgba(79,140,255,.45); border-radius:12px; background:linear-gradient(135deg, rgba(79,140,255,.12), rgba(79,140,255,.03)); padding:12px 16px 14px; margin-bottom:14px; }
  .onme-l { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:var(--accent); margin-bottom:8px; }
  .onme-row { display:flex; align-items:center; gap:12px; padding:9px 0; cursor:pointer; border-top:1px solid rgba(79,140,255,.18); }
  .onme-row:first-of-type { border-top:0; }
  .onme-badge { font-size:10px; font-weight:700; letter-spacing:.05em; border-radius:4px; padding:2px 7px; background:var(--warn); color:#0b0d10; white-space:nowrap; }
  .onme-badge.own { background:var(--accent); color:#fff; }
  .onme-t { font-size:14px; font-weight:600; }
  .onme-s { font-size:11.5px; color:var(--muted); }
  .kpi-of { font-size:14px; font-weight:500; color:var(--muted); }
  .kpi.red { border-color:rgba(229,83,75,.4); background:linear-gradient(160deg, rgba(229,83,75,.15), rgba(229,83,75,.03)); }
  .kpi.red .kpi-l { color:var(--bad); } .kpi.red::after { background:var(--bad); }
  .roster { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:16px; padding:9px 14px; border:1px solid var(--line); border-radius:9px; background:var(--panel); }
  .roster-l { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin-right:4px; }
  .who-chip { display:inline-flex; align-items:center; gap:6px; font-size:12px; border:1px solid var(--line2); border-radius:999px; padding:3px 11px; }
  .who-chip em { font-style:normal; font-size:10.5px; color:var(--muted); }
  .who-dot { width:6px; height:6px; border-radius:50%; background:var(--faint); }
  .who-chip.paged { border-color:rgba(224,164,58,.55); background:rgba(224,164,58,.1); }
  .who-chip.paged .who-dot { background:var(--warn); } .who-chip.paged em { color:var(--warn); }
  .who-chip.busy { border-color:rgba(106,161,255,.4); } .who-chip.busy .who-dot { background:var(--info); }
  .who-chip.free .who-dot { background:var(--ok); }
  .who-chip.off { opacity:.5; }
  .roster-ho { margin-left:auto; color:var(--cyan); }
  .aisle-group { margin-bottom:12px; }
  .aisle-group:last-child { margin-bottom:0; }
  .aisle-head { font-size:11.5px; font-weight:600; color:var(--text); margin:4px 0 6px; letter-spacing:.02em; }
  .q-kit { display:flex; gap:14px; flex-wrap:wrap; margin-top:5px; font-size:11px; }
  .kit-parts { color:var(--cyan); }
  .kit-haz { color:var(--warn); }
  .aisle { display:flex; align-items:stretch; gap:10px; margin-bottom:8px; }
  .aisle-l { width:52px; flex-shrink:0; font-size:11.5px; color:var(--muted); align-self:center; }
  .cdu-chip { width:52px; flex-shrink:0; border-radius:7px; border:1px solid rgba(34,211,238,.3); background:rgba(34,211,238,.09); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; }
  .cdu-chip.bad { border-color:rgba(229,83,75,.5); background:rgba(229,83,75,.12); }
  .cdu-chip-n { font-size:14px; font-weight:600; color:var(--cyan); font-variant-numeric:tabular-nums; line-height:1.1; }
  .cdu-chip.bad .cdu-chip-n { color:var(--bad); }
  .cdu-chip-l { font-size:9px; color:var(--muted); letter-spacing:.02em; }
  .aisle-racks { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; flex:1; }
  .heat { border-radius:7px; padding:9px 11px; cursor:pointer; border:1px solid rgba(255,255,255,.07); transition:transform .12s; }
  .heat:hover { transform:translateY(-1px); border-color:rgba(255,255,255,.2); }
  .heat.warning { box-shadow:0 0 0 1px rgba(224,164,58,.55); }
  .heat.nopower { box-shadow:0 0 0 1px rgba(224,164,58,.7); }
  .heat.critical, .heat.down { box-shadow:0 0 0 1px rgba(229,83,75,.75); }
  .heat.nopower .heat-tn { color:var(--warn); font-weight:600; }
  .heat-id { font-size:11px; font-weight:600; color:rgba(255,255,255,.72); }
  .heat-t { font-size:19px; font-weight:600; letter-spacing:-.01em; font-variant-numeric:tabular-nums; color:#fff; line-height:1.15; }
  .heat-tn { font-size:10px; color:rgba(255,255,255,.55); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .heat-key { gap:7px; }
  .heat-bar { width:88px; height:7px; border-radius:4px; background:linear-gradient(90deg, hsl(205 45% 26%), hsl(120 55% 30%), hsl(45 72% 36%), hsl(0 85% 42%)); }
  .ok-text { color:var(--ok); }
  .floor-sum { margin-top:12px; padding-top:11px; border-top:1px solid var(--line); font-size:11.5px; font-variant-numeric:tabular-nums; }
  .floor-sum span::before { content:none; }
  .log-kind.k-paged, .log-kind.k-page_held { color:var(--warn); }
  .log-kind.k-page_missed, .log-kind.k-page_declined { color:var(--bad); }
  .log-kind.k-claim { color:var(--info); }
  .log-kind.k-fix_verified { color:var(--ok); }
  .log-kind.k-agent_action { color:var(--violet); }
  .log-kind.k-handoff { color:var(--cyan); }
  .log-chain.on { color:var(--cyan); }
  .nav.on { box-shadow:inset 2px 0 0 var(--violet); }
  .nav em { background:var(--bad); }
  .news { display:flex; gap:8px; align-items:baseline; margin-top:6px; }
  .news-score { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; border:1px solid var(--line2); border-radius:3px; padding:0 5px; color:var(--muted); flex-shrink:0; }
  .news-score.s1 { color:var(--warn); border-color:rgba(224,164,58,.4); }
  .news-score.s2 { color:var(--bad); border-color:rgba(229,83,75,.45); }
  .ilog { display:flex; flex-direction:column; }
  .ilog-row { display:grid; grid-template-columns:96px 10px 1fr; gap:10px; align-items:baseline; padding:6px 0; border-bottom:1px solid var(--line); }
  .ilog-row:last-child { border-bottom:0; }
  .ilog-row .log-time { white-space:nowrap; }
  .ilog-dot { width:7px; height:7px; border-radius:50%; background:var(--faint); }
  .ilog-dot.red { background:var(--bad); } .ilog-dot.amber { background:var(--warn); } .ilog-dot.green { background:var(--ok); } .ilog-dot.blue { background:var(--info); }
  .stats.tight { margin:4px 0 12px; }
  .faint { color:var(--faint); }
  .callout { border-radius:6px; padding:8px 10px; margin-top:8px; border:1px solid; }
  .callout.green { color:var(--ok); border-color:rgba(63,178,127,.4); background:rgba(63,178,127,.06); margin:0 0 10px; }
  .callout.amber { color:var(--warn); border-color:rgba(224,164,58,.4); background:rgba(224,164,58,.06); }
  .callout.red { color:var(--bad); border-color:rgba(229,83,75,.45); background:rgba(229,83,75,.06); margin:0 0 10px; }
  .pages { display:flex; flex-direction:column; gap:6px; margin-top:10px; }
  .page-row { display:flex; gap:10px; align-items:center; border:1px solid var(--line); border-radius:6px; padding:8px 10px; background:var(--panel2); }
  .page-row.paging { border-color:rgba(224,164,58,.45); }
  .page-row.acknowledged { border-color:rgba(63,178,127,.4); }
  .page-row.missed, .page-row.declined { opacity:.75; }
  .avatar.sm { width:26px; height:26px; font-size:10px; }
  .primary.sm, .ghost.sm { padding:5px 10px; font-size:12px; }
  .ghost { background:none; border:1px solid var(--line2); border-radius:6px; color:var(--text); cursor:pointer; font-weight:500; }
  .ghost:hover:not(:disabled) { border-color:var(--muted); }
  .conf { height:4px; background:var(--line); border-radius:2px; overflow:hidden; margin-top:8px; }
  .conf div { height:100%; background:var(--ok); } .conf div.low { background:var(--bad); }
  .paged-banner { display:flex; gap:10px; align-items:center; border:1px solid rgba(224,164,58,.5); background:rgba(224,164,58,.08); border-radius:8px; padding:10px 14px; margin-bottom:14px; }
  .paged-banner b { color:var(--warn); }
  .section { font-size:11.5px; margin:24px 0 10px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.06em; }

  @media (max-width: 900px) {
    .shell { flex-direction:column; } aside { width:100%; height:auto; position:static; }
    nav { flex-direction:row; overflow-x:auto; } .side-foot { margin-top:12px; }
    main { padding:16px; } .stats { grid-template-columns:1fr 1fr; } .two, .split { grid-template-columns:1fr; } .split { margin:0; }
    .list-pane, .detail-pane { max-height:none; }
  }
`;
