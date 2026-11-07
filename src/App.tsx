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
  ok: 'green', warning: 'amber', critical: 'red',
  low: 'blue', medium: 'amber',
  open: 'red', claimed: 'blue', fixing: 'amber', resolved: 'green',
  pending: 'amber', complete: 'green', in_progress: 'blue', done: 'green', failed: 'red',
};
const Chip = ({ v, label }: { v: string; label?: string }) => (
  <span className={`chip ${tone[v] ?? 'gray'}`}>{(label ?? v).replace('_', ' ')}</span>
);

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

  const claimWarning = useReducer(reducers.claimWarning);
  const markFixed = useReducer(reducers.markFixed);
  const createHandoff = useReducer(reducers.createHandoff);
  const signHandoff = useReducer(reducers.signHandoff);
  const breakRack = useReducer(reducers.breakRack);
  const resetDemo = useReducer(reducers.resetDemo);

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
  const historyFor = (rackId: string) =>
    [...readings].filter(r => r.rackId === rackId).sort((a, b) => (a.id < b.id ? -1 : 1)).map(r => r.temperatureF);
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

  const openWarning = (id: bigint) => { setSelectedId(id); setFilter('all'); setView('warnings'); };

  const nav: { id: View; label: string; icon: string; badge?: number }[] = [
    { id: 'overview', label: 'Overview', icon: I.home },
    { id: 'warnings', label: 'Warnings', icon: I.alert, badge: unclaimed.length || undefined },
    { id: 'racks', label: 'Racks', icon: I.server },
    { id: 'handoffs', label: 'Handoffs', icon: I.swap, badge: pendingHandoffs.length || undefined },
    { id: 'record', label: 'Signed Record', icon: I.shield },
  ];

  const rackCard = (r: (typeof sortedRacks)[number], big?: boolean) => (
    <div key={r.id} className={`rack ${tone[r.status]}`}>
      <div className="row between">
        <b>{r.id}</b>
        <Chip v={r.status} />
      </div>
      <div className="rack-temp">{r.temperatureF.toFixed(1)}<span>°F</span></div>
      <div className="spark"><Sparkline values={historyFor(r.id)} h={big ? 44 : 30} /></div>
      <div className="row between muted xs">
        <span>Aisle {r.aisle} · {r.powerKw.toFixed(1)} kW</span>
        {r.failing ? <span className="red-text">cooling fault</span> : (
          <button className="link" onClick={() => breakRack({ rackId: r.id })} disabled={!connected}>simulate fault</button>
        )}
      </div>
    </div>
  );

  // ─── views ───
  const Overview = () => {
    const crit = racks.filter(r => r.status === 'critical').length;
    const warn = racks.filter(r => r.status === 'warning').length;
    return (
      <>
        <div className="page-head"><div><h1>Overview</h1><p className="muted">Live floor status · updates every 3 seconds</p></div></div>
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
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Needs attention</h3></div>
            {active.length === 0 && <p className="empty">All clear.</p>}
            {active.map(w => (
              <button key={w.id.toString()} className="list-item" onClick={() => openWarning(w.id)}>
                <div className="row between"><b>{w.rackId}</b><Chip v={w.severity} /></div>
                <div className="muted xs clamp">{w.message}</div>
                <div className="row between xs"><span className="muted">{ago(w.createdAt)}</span><Chip v={w.status} label={w.status === 'open' ? 'unclaimed' : w.status} /></div>
              </button>
            ))}
            <div className="panel-head" style={{ marginTop: 16 }}><h3>Recent activity</h3></div>
            {sortedRecords.slice(0, 5).map(rec => (
              <div key={rec.id.toString()} className="activity">
                <span className="dot" /> <div><div className="xs">{rec.summary}</div><div className="muted xxs">{clock(rec.createdAt)}</div></div>
              </div>
            ))}
            {records.length === 0 && <p className="empty">No activity yet.</p>}
          </div>
        </div>
      </>
    );
  };

  const Warnings = () => {
    const steps = selected ? [...tasks].filter(t0 => t0.warningId === selected.id).sort((a, b) => a.stepNumber - b.stepNumber) : [];
    const rack = selected ? racks.find(r => r.id === selected.rackId) : undefined;
    const mine = selected && me && selected.claimedBy === me.id;
    const life = selected ? [
      { label: 'Warning raised', detail: `${selected.source === 'agent' ? 'Nemotron agent' : 'Sensor rule'} · ${clock(selected.createdAt)}`, done: true },
      { label: 'Claimed & signed', detail: selected.claimedAt ? `${nameOf(selected.claimedBy)} · ${clock(selected.claimedAt)}` : 'Waiting for an owner', done: !!selected.claimedAt, current: selected.status === 'open' },
      { label: 'Fix submitted', detail: selected.status === 'fixing' || selected.status === 'resolved' ? 'Tech marked the fix done' : 'Not yet', done: selected.status === 'fixing' || selected.status === 'resolved', current: selected.status === 'claimed' },
      { label: 'Verified by data', detail: selected.resolvedAt ? `Temp back to normal · ${clock(selected.resolvedAt)}` : 'Waits for temperature under 78°F', done: selected.status === 'resolved', current: selected.status === 'fixing' },
    ] : [];
    return (
      <div className="split">
        <div className="list-pane">
          <div className="tabs">
            {(['all', 'open', 'claimed', 'fixing', 'resolved'] as const).map(f => (
              <button key={f} className={filter === f ? 'tab on' : 'tab'} onClick={() => setFilter(f)}>{f === 'open' ? 'Unclaimed' : f[0].toUpperCase() + f.slice(1)}</button>
            ))}
          </div>
          {filtered.length === 0 && <p className="empty">Nothing here.</p>}
          {filtered.map(w => (
            <button key={w.id.toString()} className={`list-item ${selected?.id === w.id ? 'sel' : ''}`} onClick={() => setSelectedId(w.id)}>
              <div className="row between"><b>{w.rackId} · {w.severity === 'critical' ? 'Critical overheat' : 'Temperature rising'}</b></div>
              <div className="muted xs clamp">{w.message}</div>
              <div className="row between xs"><span className="muted">{ago(w.createdAt)}</span><Chip v={w.status} label={w.status === 'open' ? 'unclaimed' : w.status} /></div>
            </button>
          ))}
        </div>

        <div className="detail-pane">
          {!selected ? <p className="empty">Select a warning.</p> : (
            <>
              <div className="row between wrap">
                <h1>{selected.rackId} · {selected.severity === 'critical' ? 'Critical overheat' : 'Temperature rising'}</h1>
                <div className="row"><Chip v={selected.severity} /><Chip v={selected.status} label={selected.status === 'open' ? 'unclaimed' : selected.status} /></div>
              </div>
              <p className="muted">{selected.message}</p>

              <div className="stats three">
                <Stat label="Current temp" value={rack ? `${rack.temperatureF.toFixed(1)}°F` : '—'} t={rack ? tone[rack.status] : ''} />
                <Stat label="Owner" value={selected.claimedBy !== undefined ? nameOf(selected.claimedBy) : 'Nobody'} t={selected.claimedBy === undefined ? 'red' : ''} />
                <Stat label="Opened" value={ago(selected.createdAt)} sub={clock(selected.createdAt)} />
              </div>

              <div className="actions">
                {selected.status === 'open' && <button className="primary" disabled={busy} onClick={() => me && claimWarning({ warningId: selected.id, techId: me.id })}>Claim & sign as {me?.name.split(' ')[0]}</button>}
                {selected.status === 'claimed' && (mine
                  ? <button className="primary" disabled={busy} onClick={() => me && markFixed({ warningId: selected.id, techId: me.id })}>Mark fix done</button>
                  : <span className="muted xs">Only {nameOf(selected.claimedBy)} can mark this fixed.</span>)}
                {selected.status === 'fixing' && <span className="muted xs">⏳ Watching sensor data to confirm the fix…</span>}
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
      <div className="page-head"><div><h1>Signed record</h1><p className="muted">Claims, verified fixes and handoffs. Each one gets written to Solana devnet.</p></div></div>
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
                <td className="mono">{rec.txSignature ? `${rec.txSignature.slice(0, 8)}…` : <span className="muted">pending</span>}</td>
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
  :root { --bg:#070b0a; --side:#0c1311; --panel:rgba(255,255,255,.035); --line:rgba(255,255,255,.07); --text:#e6ece9; --muted:#8a9a94; --accent:#3ddc97; --accent-d:#1f8f5f; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 Inter, system-ui, sans-serif; }
  button { font:inherit; color:inherit; }
  .shell { display:flex; min-height:100vh; background: radial-gradient(1200px 600px at 85% -10%, rgba(61,220,151,.10), transparent 60%), var(--bg); }
  aside { width:240px; flex-shrink:0; background:var(--side); border-right:1px solid var(--line); display:flex; flex-direction:column; padding:18px 12px; position:sticky; top:0; height:100vh; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:17px; padding:4px 8px 18px; }
  .logo { width:32px; height:32px; border-radius:9px; background:linear-gradient(135deg,var(--accent),var(--accent-d)); color:#04130c; display:grid; place-items:center; }
  nav { display:flex; flex-direction:column; gap:2px; }
  .nav { display:flex; align-items:center; gap:10px; background:none; border:0; padding:9px 10px; border-radius:9px; color:var(--muted); cursor:pointer; text-align:left; }
  .nav:hover { background:rgba(255,255,255,.04); color:var(--text); }
  .nav.on { background:rgba(61,220,151,.12); color:var(--accent); }
  .nav span { flex:1; }
  .nav em { font-style:normal; font-size:11px; font-weight:700; background:#ef4444; color:#fff; border-radius:999px; padding:1px 7px; }
  .side-foot { margin-top:auto; display:flex; flex-direction:column; gap:10px; padding:0 6px; }
  .live { width:8px; height:8px; border-radius:50%; background:#ef4444; }
  .live.on { background:var(--accent); box-shadow:0 0 0 4px rgba(61,220,151,.15); }
  .me { display:flex; gap:10px; align-items:center; border-top:1px solid var(--line); padding-top:12px; }
  .me-info { min-width:0; flex:1; }
  .me select { width:100%; background:none; border:0; color:var(--text); font-weight:600; padding:0; cursor:pointer; }
  .me select option { background:#111; }
  .avatar { width:34px; height:34px; border-radius:50%; background:rgba(61,220,151,.15); color:var(--accent); display:grid; place-items:center; font-weight:700; font-size:12px; flex-shrink:0; }
  main { flex:1; padding:28px 32px; min-width:0; }
  .page-head { margin-bottom:18px; }
  h1 { font-size:22px; margin:0 0 4px; font-weight:650; }
  h3 { font-size:13px; margin:0 0 12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.05em; }
  p { margin:4px 0; }
  .muted { color:var(--muted); } .xs { font-size:12.5px; } .xxs { font-size:11px; }
  .row { display:flex; align-items:center; gap:8px; } .between { justify-content:space-between; } .wrap { flex-wrap:wrap; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:18px; }
  .stats.three { grid-template-columns:repeat(3,1fr); margin:16px 0; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .stat-label { font-size:12px; color:var(--muted); } .stat-value { font-size:22px; font-weight:650; margin-top:4px; } .stat-sub { font-size:11.5px; color:var(--muted); }
  .stat.green { background:rgba(34,197,94,.07); border-color:rgba(34,197,94,.2); }
  .stat.amber { background:rgba(245,158,11,.07); border-color:rgba(245,158,11,.22); }
  .stat.red { background:rgba(239,68,68,.08); border-color:rgba(239,68,68,.25); }
  .two { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr); gap:16px; align-items:start; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:14px; backdrop-filter:blur(8px); }
  .panel-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; } .panel-head h3 { margin:0; }
  .rack-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .rack-grid.big { grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); }
  .rack { border:1px solid var(--line); border-radius:12px; padding:12px; background:rgba(255,255,255,.02); }
  .rack.amber { border-color:rgba(245,158,11,.45); } .rack.red { border-color:rgba(239,68,68,.6); box-shadow:0 0 24px rgba(239,68,68,.12); }
  .rack-temp { font-size:26px; font-weight:700; margin:6px 0 2px; } .rack-temp span { font-size:14px; color:var(--muted); margin-left:2px; }
  .spark { color:var(--accent); margin-bottom:6px; } .rack.amber .spark { color:#f59e0b; } .rack.red .spark { color:#ef4444; }
  .chip { font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; padding:2px 8px; border-radius:6px; border:1px solid; white-space:nowrap; }
  .chip.green { color:#4ade80; border-color:rgba(74,222,128,.3); background:rgba(74,222,128,.08); }
  .chip.amber { color:#fbbf24; border-color:rgba(251,191,36,.3); background:rgba(251,191,36,.08); }
  .chip.red { color:#f87171; border-color:rgba(248,113,113,.35); background:rgba(248,113,113,.1); }
  .chip.blue { color:#60a5fa; border-color:rgba(96,165,250,.3); background:rgba(96,165,250,.08); }
  .chip.gray { color:var(--muted); border-color:var(--line); }
  .red-text { color:#f87171; } .green-text { color:#4ade80; }
  .link { background:none; border:0; color:var(--muted); text-decoration:underline; cursor:pointer; padding:0; font-size:12px; text-align:left; }
  .link:hover { color:var(--accent); }
  button:disabled { opacity:.4; cursor:default; }
  .primary { background:var(--accent); color:#04130c; border:0; border-radius:9px; padding:9px 16px; font-weight:650; cursor:pointer; }
  .primary:hover:not(:disabled) { filter:brightness(1.1); }
  .list-item { display:block; width:100%; text-align:left; background:none; border:0; border-bottom:1px solid var(--line); padding:12px 10px; cursor:pointer; border-radius:8px; }
  .list-item:hover { background:rgba(255,255,255,.03); }
  .list-item.sel { background:rgba(61,220,151,.08); box-shadow:inset 3px 0 0 var(--accent); }
  .list-item > * + * { margin-top:4px; }
  .clamp { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .activity { display:flex; gap:10px; align-items:flex-start; padding:6px 0; } .dot { width:7px; height:7px; border-radius:50%; background:var(--accent); margin-top:6px; flex-shrink:0; }
  .empty { color:var(--muted); font-size:13px; padding:8px 0; }
  .split { display:grid; grid-template-columns:340px minmax(0,1fr); gap:0; margin:-28px -32px; min-height:100vh; }
  .list-pane { border-right:1px solid var(--line); padding:20px 14px; overflow-y:auto; max-height:100vh; }
  .detail-pane { padding:28px 32px; overflow-y:auto; max-height:100vh; }
  .tabs { display:flex; gap:4px; margin-bottom:10px; flex-wrap:wrap; }
  .tab { background:none; border:1px solid transparent; color:var(--muted); padding:5px 10px; border-radius:7px; cursor:pointer; font-size:12.5px; }
  .tab.on { background:rgba(61,220,151,.12); color:var(--accent); border-color:rgba(61,220,151,.25); }
  .actions { display:flex; gap:10px; align-items:center; margin:4px 0 16px; min-height:38px; }
  .timeline { display:flex; flex-direction:column; }
  .tl { display:flex; gap:12px; position:relative; padding-bottom:18px; }
  .tl:not(:last-child)::before { content:''; position:absolute; left:11px; top:24px; bottom:0; width:2px; background:var(--line); }
  .tl.done:not(:last-child)::before { background:var(--accent-d); }
  .tl-dot { width:24px; height:24px; border-radius:50%; border:2px solid var(--line); display:grid; place-items:center; font-size:12px; flex-shrink:0; background:var(--bg); }
  .tl.done .tl-dot { background:var(--accent); border-color:var(--accent); color:#04130c; font-weight:700; }
  .tl.cur .tl-dot { border-color:#60a5fa; box-shadow:0 0 0 4px rgba(96,165,250,.15); }
  .tl-title { font-weight:600; }
  .field { display:flex; flex-direction:column; gap:5px; font-size:12px; color:var(--muted); margin-bottom:12px; }
  input, select, textarea { background:rgba(0,0,0,.3); color:var(--text); border:1px solid var(--line); border-radius:9px; padding:9px 10px; font:inherit; }
  textarea { min-height:70px; resize:vertical; }
  pre { white-space:pre-wrap; font:12.5px/1.5 ui-monospace,monospace; color:#c8d3cf; background:rgba(0,0,0,.25); border-radius:9px; padding:10px; margin:10px 0; }
  .sigs { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; }
  .sig { display:flex; gap:8px; align-items:center; border:1px dashed var(--line); border-radius:10px; padding:8px; }
  .sig.signed { border-style:solid; border-color:rgba(61,220,151,.35); background:rgba(61,220,151,.05); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--muted); font-weight:500; font-size:12px; padding:8px; border-bottom:1px solid var(--line); }
  td { padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  .mono { font-family:ui-monospace,monospace; font-size:12px; }
  @media (max-width: 900px) {
    .shell { flex-direction:column; } aside { width:100%; height:auto; position:static; }
    nav { flex-direction:row; overflow-x:auto; } .side-foot { margin-top:12px; }
    main { padding:16px; } .stats { grid-template-columns:1fr 1fr; } .two, .split { grid-template-columns:1fr; } .split { margin:0; }
    .list-pane, .detail-pane { max-height:none; }
  }
`;
