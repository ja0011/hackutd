import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// ─────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────

// People who work the floor. role: 'junior' | 'senior' | 'supervisor'
const tech = table(
  { name: 'tech', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    role: t.string(),
    shift: t.string(), // 'day' | 'night'
    walletPubkey: t.string(), // Solana public key, filled in by the chain service
  }
);

// One row per rack, holding its latest sensor state.
// status: 'ok' | 'warning' | 'critical' (worst of all sensors)
const rack = table(
  { name: 'rack', public: true },
  {
    id: t.string().primaryKey(), // e.g. 'R-12'
    aisle: t.string(),
    temperatureF: t.f64(),
    powerKw: t.f64(),
    humidityPct: t.f64(),
    diskErrors: t.u32(),
    packetLossPct: t.f64(),
    pduAOnline: t.bool(), // two power feeds (A and B); each server is plugged into both
    pduBOnline: t.bool(),
    pduALoadPct: t.f64(), // % of that PDU's circuit capacity in use
    pduBLoadPct: t.f64(),
    status: t.string(), // 'ok' | 'warning' | 'critical' | 'down'
    fault: t.string(), // '' | 'cooling' | 'power' | 'disk' | 'network' | 'humidity' | 'pdu'
  }
);

// Rolling history of readings (old rows are pruned each tick).
const sensorReading = table(
  { name: 'sensor_reading', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    rackId: t.string().index('btree'),
    temperatureF: t.f64(),
    powerKw: t.f64(),
    humidityPct: t.f64(),
    diskErrors: t.u32(),
    packetLossPct: t.f64(),
    pduALoadPct: t.f64(),
    pduBLoadPct: t.f64(),
    at: t.timestamp(),
  }
);

// Coolant Distribution Units: pump liquid coolant to the GPU racks in one aisle.
// fault: '' | 'pump' | 'leak'   status: 'ok' | 'warning' | 'critical'
const cdu = table(
  { name: 'cdu', public: true },
  {
    id: t.string().primaryKey(), // 'CDU-A' serves aisle A, etc.
    aisle: t.string(),
    flowLpm: t.f64(), // coolant flow, liters per minute (normal ~120)
    pressureKpa: t.f64(), // loop pressure (normal ~210)
    supplyTempC: t.f64(), // coolant temperature going out to the racks (normal ~24)
    status: t.string(),
    fault: t.string(),
  }
);

const cduReading = table(
  { name: 'cdu_reading', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    cduId: t.string().index('btree'),
    flowLpm: t.f64(),
    pressureKpa: t.f64(),
    supplyTempC: t.f64(),
    at: t.timestamp(),
  }
);

// A problem that someone has to own.
// kind: 'cooling' | 'power' | 'disk' | 'network' | 'humidity' | 'pdu' | 'cdu' | 'reported'
// rackId holds a rack id ('R-12') or, for CDU warnings, the CDU id ('CDU-A')
// severity: 'low' | 'medium' | 'critical'
// status: 'open' | 'claimed' | 'fixing' | 'resolved'
// source: 'rule' | 'agent' | 'tech'
const warning = table(
  { name: 'warning', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    rackId: t.string().index('btree'),
    kind: t.string(),
    severity: t.string(),
    message: t.string(),
    status: t.string(),
    source: t.string(),
    reportedBy: t.option(t.u64()),
    createdAt: t.timestamp(),
    claimedBy: t.option(t.u64()),
    claimedAt: t.option(t.timestamp()),
    verifiedBy: t.option(t.u64()), // for reported issues: a second tech confirms the fix
    resolvedAt: t.option(t.timestamp()),
  }
);

// Plan steps for a warning (written by the Nemotron agent).
// executor: 'agent' | 'tech'   status: 'pending' | 'in_progress' | 'done' | 'failed'
const task = table(
  { name: 'task', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    warningId: t.u64().index('btree'),
    stepNumber: t.u32(),
    description: t.string(),
    executor: t.string(),
    status: t.string(),
    result: t.string(),
  }
);

// Shift handoff: both techs must sign.  status: 'pending' | 'complete'
const handoff = table(
  { name: 'handoff', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    fromTechId: t.u64(),
    toTechId: t.u64(),
    brief: t.string(),
    openWarningIds: t.array(t.u64()),
    createdAt: t.timestamp(),
    fromSignedAt: t.option(t.timestamp()),
    toSignedAt: t.option(t.timestamp()),
    status: t.string(),
  }
);

// Moments that get written to the blockchain.
// kind: 'claim' | 'fix_verified' | 'handoff'. txSignature stays empty until written on-chain.
const chainRecord = table(
  { name: 'chain_record', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    kind: t.string(),
    refId: t.u64(),
    techIds: t.array(t.u64()),
    summary: t.string(),
    createdAt: t.timestamp(),
    txSignature: t.string(),
  }
);

// Fires the sensor simulator every few seconds.
const simTimer = table(
  { name: 'sim_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({ tech, rack, sensorReading, cdu, cduReading, warning, task, handoff, chainRecord, simTimer });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type Rack = NonNullable<ReturnType<Ctx['db']['rack']['id']['find']>>;
type Cdu = NonNullable<ReturnType<Ctx['db']['cdu']['id']['find']>>;

// ─────────────────────────────────────────────────────────────
// Sensors: thresholds per issue type
// ─────────────────────────────────────────────────────────────

const TICK_MICROS = 3_000_000n; // one reading every 3 seconds
const KEEP_READINGS_PER_RACK = 40;

type SensorKind = 'cooling' | 'power' | 'disk' | 'network' | 'humidity' | 'pdu';
const SENSORS: Record<SensorKind, { warn: number; crit: number; ok: number; unit: string; title: string; read: (r: Rack) => number }> = {
  cooling: { warn: 82, crit: 90, ok: 78, unit: '°F', title: 'Overheating', read: r => r.temperatureF },
  power: { warn: 14, crit: 17, ok: 12, unit: ' kW', title: 'Power draw spike', read: r => r.powerKw },
  disk: { warn: 10, crit: 30, ok: 1, unit: ' errors', title: 'Disk errors rising', read: r => r.diskErrors },
  network: { warn: 3, crit: 8, ok: 1, unit: '% loss', title: 'Network packet loss', read: r => r.packetLossPct },
  humidity: { warn: 60, crit: 70, ok: 55, unit: '% RH', title: 'Humidity out of range', read: r => r.humidityPct },
  // PDU: worst-loaded feed. Losing a feed is handled separately (it's instant, not a trend).
  pdu: { warn: 80, crit: 95, ok: 70, unit: '% PDU load', title: 'PDU overload', read: r => Math.max(r.pduALoadPct, r.pduBLoadPct) },
};
const PDU_CAPACITY_KW = 12; // per feed

// CDU limits (low values are bad)
const CDU = {
  flow: { warn: 90, crit: 50, ok: 105 },
  pressure: { warn: 160, crit: 110, ok: 190 },
};
function cduLevel(c: { flowLpm: number; pressureKpa: number }): 'ok' | 'medium' | 'critical' {
  if (c.flowLpm < CDU.flow.crit || c.pressureKpa < CDU.pressure.crit) return 'critical';
  if (c.flowLpm < CDU.flow.warn || c.pressureKpa < CDU.pressure.warn) return 'medium';
  return 'ok';
}
const SENSOR_KINDS = Object.keys(SENSORS) as SensorKind[];
const isSensorKind = (k: string): k is SensorKind => k in SENSORS;

function levelFor(kind: SensorKind, v: number): 'ok' | 'medium' | 'critical' {
  const s = SENSORS[kind];
  if (v >= s.crit) return 'critical';
  if (v >= s.warn) return 'medium';
  return 'ok';
}

function seed(ctx: Ctx) {
  const techs = [
    { name: 'Alex Rivera', role: 'senior', shift: 'night' },
    { name: 'Jordan Lee', role: 'junior', shift: 'night' },
    { name: 'Sam Patel', role: 'senior', shift: 'day' },
    { name: 'Morgan Diaz', role: 'supervisor', shift: 'day' },
  ];
  for (const x of techs) ctx.db.tech.insert({ id: 0n, walletPubkey: '', ...x });

  seedRacks(ctx);
}

function seedRacks(ctx: Ctx) {
  const aisles = ['A', 'A', 'A', 'B', 'B', 'B', 'C', 'C', 'C'];
  aisles.forEach((aisle, i) =>
    ctx.db.rack.insert({
      id: `R-${String(i + 10)}`,
      aisle,
      temperatureF: 72 + ctx.random() * 2,
      powerKw: 8 + ctx.random() * 2,
      humidityPct: 44 + ctx.random() * 4,
      diskErrors: 0,
      packetLossPct: ctx.random() * 0.3,
      pduAOnline: true,
      pduBOnline: true,
      pduALoadPct: 38,
      pduBLoadPct: 38,
      status: 'ok',
      fault: '',
    })
  );
  for (const aisle of ['A', 'B', 'C']) {
    ctx.db.cdu.insert({ id: `CDU-${aisle}`, aisle, flowLpm: 120, pressureKpa: 210, supplyTempC: 24, status: 'ok', fault: '' });
  }
}

function startTimer(ctx: Ctx) {
  for (const row of ctx.db.simTimer.iter()) ctx.db.simTimer.scheduledId.delete(row.scheduledId);
  ctx.db.simTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(TICK_MICROS) });
}

function activeWarningFor(ctx: Ctx, rackId: string, kind: string) {
  return [...ctx.db.warning.rackId.filter(rackId)].find(w => w.kind === kind && w.status !== 'resolved');
}

function newWarning(ctx: Ctx, rackId: string, kind: string, severity: string, message: string, source: string, reportedBy?: bigint) {
  return ctx.db.warning.insert({
    id: 0n,
    rackId,
    kind,
    severity,
    message,
    status: 'open',
    source,
    reportedBy,
    createdAt: ctx.timestamp,
    claimedBy: undefined,
    claimedAt: undefined,
    verifiedBy: undefined,
    resolvedAt: undefined,
  });
}

function resolve(ctx: Ctx, w: NonNullable<ReturnType<Ctx['db']['warning']['id']['find']>>, summary: string, techIds: bigint[], verifiedBy?: bigint) {
  ctx.db.warning.id.update({ ...w, status: 'resolved', resolvedAt: ctx.timestamp, verifiedBy: verifiedBy ?? w.verifiedBy });
  ctx.db.chainRecord.insert({ id: 0n, kind: 'fix_verified', refId: w.id, techIds, summary, createdAt: ctx.timestamp, txSignature: '' });
}

// ─────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────

export const init = spacetimedb.init(ctx => {
  seed(ctx);
  startTimer(ctx);
});
export const onConnect = spacetimedb.clientConnected(_ctx => {});
export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {});

// ─────────────────────────────────────────────────────────────
// Simulator tick: new readings, rule detection, fix verification
// ─────────────────────────────────────────────────────────────

// Moves a reading toward its normal value. Recovery (after a fix) is faster than drifting away,
// so a verified fix clears in ~10-20 seconds during a demo.
const drift = (v: number, target: number, ctx: Ctx, noise: number, rate = 0.25) => v + (target - v) * rate + (ctx.random() - 0.5) * noise;
const RECOVER = 0.6;

export const simTick = spacetimedb.reducer({ onSchedule: simTimer }, { timer: simTimer.rowType }, (ctx, { timer: _timer }) => {
  // ── CDUs first: their health decides how hot the racks in their aisle run.
  const cduHealth = new Map<string, number>(); // aisle -> 0 (dead) .. 1 (healthy)
  for (const c of [...ctx.db.cdu.iter()]) {
    const flowLpm =
      c.fault === 'pump' ? Math.max(8, c.flowLpm - 4 - ctx.random() * 2)
      : c.fault === 'leak' ? Math.max(30, c.flowLpm - 2 - ctx.random() * 2)
      : drift(c.flowLpm, 120, ctx, 2, RECOVER);
    const pressureKpa =
      c.fault === 'leak' ? Math.max(40, c.pressureKpa - 5 - ctx.random() * 3)
      : c.fault === 'pump' ? Math.max(90, c.pressureKpa - 3)
      : drift(c.pressureKpa, 210, ctx, 3, RECOVER);
    const health = Math.min(1, Math.min(flowLpm / 120, pressureKpa / 210));
    const supplyTarget = 24 + (1 - health) * 18;
    const supplyTempC = drift(c.supplyTempC, supplyTarget, ctx, 0.3, c.supplyTempC > supplyTarget ? RECOVER : 0.25);
    const level = cduLevel({ flowLpm, pressureKpa });
    const next: Cdu = { ...c, flowLpm, pressureKpa, supplyTempC, status: level === 'medium' ? 'warning' : level };
    ctx.db.cdu.id.update(next);
    ctx.db.cduReading.insert({ id: 0n, cduId: c.id, flowLpm, pressureKpa, supplyTempC, at: ctx.timestamp });
    const old = [...ctx.db.cduReading.cduId.filter(c.id)].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const o of old.slice(0, Math.max(0, old.length - KEEP_READINGS_PER_RACK))) ctx.db.cduReading.id.delete(o.id);
    cduHealth.set(c.aisle, health);

    const active = activeWarningFor(ctx, c.id, 'cdu');
    if (!active && level !== 'ok') {
      newWarning(ctx, c.id, 'cdu', level, `${c.id} coolant ${c.fault === 'leak' ? 'pressure dropping' : 'flow dropping'}: ${flowLpm.toFixed(0)} L/min, ${pressureKpa.toFixed(0)} kPa. Every rack in aisle ${c.aisle} is at risk.`, 'rule');
    } else if (active && active.status !== 'fixing' && level === 'critical' && active.severity !== 'critical') {
      ctx.db.warning.id.update({ ...active, severity: 'critical' });
    }
    if (active && active.status === 'fixing' && flowLpm >= CDU.flow.ok && pressureKpa >= CDU.pressure.ok) {
      const owner = active.claimedBy;
      resolve(ctx, active, `${c.id} coolant back to ${flowLpm.toFixed(0)} L/min, ${pressureKpa.toFixed(0)} kPa. Verified by sensor data.`, owner === undefined ? [] : [owner]);
    }
  }

  for (const r of [...ctx.db.rack.iter()]) {
    const f = r.fault;
    const down = !r.pduAOnline && !r.pduBOnline;
    // A failing CDU makes every rack in its aisle run hotter.
    const coolLoss = 1 - (cduHealth.get(r.aisle) ?? 1);
    const tempTarget = 72.5 + coolLoss * 26;
    const temperatureF =
      down ? drift(r.temperatureF, 70, ctx, 0.4)
      : f === 'cooling' ? r.temperatureF + 0.6 + ctx.random() * 0.5
      : f === 'power' ? r.temperatureF + 0.15 + ctx.random() * 0.1
      : drift(r.temperatureF, tempTarget, ctx, 0.8, r.temperatureF > tempTarget + 1 ? RECOVER : 0.25);
    const powerKw = down ? 0 : f === 'power' ? r.powerKw + 0.35 + ctx.random() * 0.3 : Math.max(5, drift(r.powerKw || 9, 9, ctx, 0.3, RECOVER));
    const humidityPct = f === 'humidity' ? r.humidityPct + 0.8 + ctx.random() * 0.6 : drift(r.humidityPct, 46, ctx, 0.6, r.humidityPct > 48 ? RECOVER : 0.25);
    const diskErrors = f === 'disk' ? r.diskErrors + 1 + Math.floor(ctx.random() * 3) : r.diskErrors;
    const packetLossPct = down ? 0 : f === 'network' ? r.packetLossPct + 0.3 + ctx.random() * 0.4 : Math.max(0, drift(r.packetLossPct, 0.1, ctx, 0.1, RECOVER));

    // Power splits across whichever feeds are still up.
    let pduAOnline = r.pduAOnline;
    let pduBOnline = r.pduBOnline;
    const feeds = (pduAOnline ? 1 : 0) + (pduBOnline ? 1 : 0);
    const perFeed = feeds ? (powerKw / feeds / PDU_CAPACITY_KW) * 100 : 0;
    let pduALoadPct = pduAOnline ? perFeed : 0;
    let pduBLoadPct = pduBOnline ? perFeed : 0;
    let tripped = false;
    // One feed left and it's over 100%: the breaker trips and the whole rack goes dark.
    if (feeds === 1 && perFeed >= 100) {
      pduAOnline = false;
      pduBOnline = false;
      pduALoadPct = 0;
      pduBLoadPct = 0;
      tripped = true;
    }

    const next: Rack = { ...r, temperatureF, powerKw: tripped ? 0 : powerKw, humidityPct, diskErrors, packetLossPct, pduAOnline, pduBOnline, pduALoadPct, pduBLoadPct };
    const isDown = !pduAOnline && !pduBOnline;
    const levels = SENSOR_KINDS.map(k => levelFor(k, SENSORS[k].read(next)));
    const oneFeed = (pduAOnline ? 1 : 0) + (pduBOnline ? 1 : 0) === 1;
    next.status = isDown ? 'down' : levels.includes('critical') ? 'critical' : levels.includes('medium') || oneFeed ? 'warning' : 'ok';
    ctx.db.rack.id.update(next);
    ctx.db.sensorReading.insert({ id: 0n, rackId: r.id, temperatureF, powerKw: next.powerKw, humidityPct, diskErrors, packetLossPct, pduALoadPct, pduBLoadPct, at: ctx.timestamp });

    const readings = [...ctx.db.sensorReading.rackId.filter(r.id)].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const old of readings.slice(0, Math.max(0, readings.length - KEEP_READINGS_PER_RACK))) ctx.db.sensorReading.id.delete(old.id);

    // ── PDU: losing a feed is instant. Running on one feed = no backup.
    const pduActive = activeWarningFor(ctx, r.id, 'pdu');
    if (tripped) {
      if (pduActive) ctx.db.warning.id.update({ ...pduActive, severity: 'critical', message: `${r.id} LOST POWER: the last PDU feed overloaded and tripped. Every server in the rack is down.` });
      else newWarning(ctx, r.id, 'pdu', 'critical', `${r.id} LOST POWER: the last PDU feed overloaded and tripped. Every server in the rack is down.`, 'rule');
    } else if (!pduActive && oneFeed) {
      newWarning(ctx, r.id, 'pdu', 'medium', `${r.id} is running on PDU ${pduAOnline ? 'A' : 'B'} only (${Math.max(pduALoadPct, pduBLoadPct).toFixed(0)}% load). No backup power: one more failure takes the rack down.`, 'rule');
    }

    for (const kind of SENSOR_KINDS) {
      const s = SENSORS[kind];
      const v = s.read(next);
      const level = levelFor(kind, v);
      const active = activeWarningFor(ctx, r.id, kind);
      if (isDown) continue; // a dark rack has no meaningful readings

      if (!active && level !== 'ok') {
        newWarning(ctx, r.id, kind, level, `${r.id}: ${s.title.toLowerCase()} at ${v.toFixed(kind === 'disk' ? 0 : 1)}${s.unit}.`, 'rule');
      } else if (active && active.status !== 'fixing' && level === 'critical' && active.severity !== 'critical') {
        ctx.db.warning.id.update({ ...active, severity: 'critical' });
      }

      // Overheating caused by a failing CDU clears on its own once that CDU is fixed.
      if (active && kind === 'cooling' && active.status !== 'fixing' && r.fault !== 'cooling' && v < s.ok && (cduHealth.get(r.aisle) ?? 1) > 0.9) {
        const rootCause = [...ctx.db.warning.rackId.filter(`CDU-${r.aisle}`)].some(w => w.kind === 'cdu');
        if (rootCause) {
          resolve(ctx, active, `${r.id} back to ${v.toFixed(1)}°F after CDU-${r.aisle} was fixed (root cause).`, active.claimedBy === undefined ? [] : [active.claimedBy]);
          continue;
        }
      }

      // Verification: a fix only counts once the sensor data says it worked.
      const pduHealthy = kind !== 'pdu' || (pduAOnline && pduBOnline);
      if (active && active.status === 'fixing' && v < s.ok && pduHealthy) {
        const owner = active.claimedBy;
        const summary =
          kind === 'pdu'
            ? `${r.id} PDU A and B both back online, ${v.toFixed(0)}% load each. Verified by sensor data.`
            : `${r.id} ${s.title.toLowerCase()} cleared (${v.toFixed(kind === 'disk' ? 0 : 1)}${s.unit}). Verified by sensor data.`;
        resolve(ctx, active, summary, owner === undefined ? [] : [owner]);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────
// Tech actions
// ─────────────────────────────────────────────────────────────

function requireTech(ctx: Ctx, techId: bigint) {
  const row = ctx.db.tech.id.find(techId);
  if (!row) throw new SenderError('Unknown tech');
  return row;
}

// Something sensors can't see: a leak, a smell, noise, a damaged cable…
export const reportIssue = spacetimedb.reducer(
  { rackId: t.string(), techId: t.u64(), severity: t.string(), description: t.string() },
  (ctx, { rackId, techId, severity, description }) => {
    const who = requireTech(ctx, techId);
    if (!ctx.db.rack.id.find(rackId)) throw new SenderError('Rack not found');
    if (!description.trim()) throw new SenderError('Describe what you saw');
    const sev = ['low', 'medium', 'critical'].includes(severity) ? severity : 'medium';
    newWarning(ctx, rackId, 'reported', sev, `${description.trim()} (reported by ${who.name})`, 'tech', techId);
  }
);

export const claimWarning = spacetimedb.reducer({ warningId: t.u64(), techId: t.u64() }, (ctx, { warningId, techId }) => {
  const who = requireTech(ctx, techId);
  const w = ctx.db.warning.id.find(warningId);
  if (!w) throw new SenderError('Warning not found');
  if (w.status !== 'open') throw new SenderError('Warning already claimed');
  ctx.db.warning.id.update({ ...w, status: 'claimed', claimedBy: techId, claimedAt: ctx.timestamp });
  ctx.db.chainRecord.insert({
    id: 0n,
    kind: 'claim',
    refId: warningId,
    techIds: [techId],
    summary: `${who.name} took ownership of the ${w.rackId} ${w.kind === 'reported' ? 'reported issue' : 'warning'}.`,
    createdAt: ctx.timestamp,
    txSignature: '',
  });
});

// The owner says the physical fix is done. Sensor issues resolve when the data confirms it;
// reported issues need a second tech to verify.
export const markFixed = spacetimedb.reducer({ warningId: t.u64(), techId: t.u64() }, (ctx, { warningId, techId }) => {
  const who = requireTech(ctx, techId);
  const w = ctx.db.warning.id.find(warningId);
  if (!w) throw new SenderError('Warning not found');
  if (w.claimedBy !== techId) throw new SenderError('Only the owner can mark this fixed');
  ctx.db.warning.id.update({ ...w, status: 'fixing' });
  for (const tk of [...ctx.db.task.warningId.filter(warningId)]) {
    if (tk.executor === 'tech' && tk.status !== 'done') ctx.db.task.id.update({ ...tk, status: 'done', result: `Done by ${who.name}` });
  }
  if (w.kind === 'cdu') {
    const c = ctx.db.cdu.id.find(w.rackId);
    if (c) ctx.db.cdu.id.update({ ...c, fault: '' });
    return;
  }
  const r = ctx.db.rack.id.find(w.rackId);
  if (!r) return;
  if (w.kind === 'pdu') {
    // Feed restored / load rebalanced: both PDUs back online, power back on.
    ctx.db.rack.id.update({ ...r, fault: r.fault === 'pdu' || r.fault === 'power' ? '' : r.fault, pduAOnline: true, pduBOnline: true, powerKw: r.powerKw || 9 });
  } else if (w.kind === r.fault) {
    ctx.db.rack.id.update({ ...r, fault: '', diskErrors: w.kind === 'disk' ? 0 : r.diskErrors });
  }
});

export const verifyFix = spacetimedb.reducer({ warningId: t.u64(), techId: t.u64() }, (ctx, { warningId, techId }) => {
  const who = requireTech(ctx, techId);
  const w = ctx.db.warning.id.find(warningId);
  if (!w) throw new SenderError('Warning not found');
  if (w.kind !== 'reported') throw new SenderError('Sensor issues are verified by data');
  if (w.status !== 'fixing') throw new SenderError('Nothing to verify yet');
  if (w.claimedBy === techId) throw new SenderError('A different tech has to verify your fix');
  const owner = w.claimedBy;
  resolve(ctx, w, `${w.rackId} reported issue fixed by ${owner !== undefined ? ctx.db.tech.id.find(owner)?.name ?? '?' : '?'}, verified by ${who.name}.`, owner === undefined ? [techId] : [owner, techId], techId);
});

// ─────────────────────────────────────────────────────────────
// Agent actions
// ─────────────────────────────────────────────────────────────

// The Nemotron agent raises an early warning before the hard rule trips.
export const raiseWarning = spacetimedb.reducer(
  { rackId: t.string(), kind: t.string(), severity: t.string(), message: t.string() },
  (ctx, { rackId, kind, severity, message }) => {
    const isCdu = !!ctx.db.cdu.id.find(rackId);
    if (!isCdu && !ctx.db.rack.id.find(rackId)) throw new SenderError('Rack or CDU not found');
    const k = isCdu ? 'cdu' : isSensorKind(kind) ? kind : 'cooling';
    if (activeWarningFor(ctx, rackId, k)) return; // already being handled
    const sev = ['low', 'medium', 'critical'].includes(severity) ? severity : 'medium';
    newWarning(ctx, rackId, k, sev, message, 'agent');
  }
);

export const addTask = spacetimedb.reducer(
  { warningId: t.u64(), stepNumber: t.u32(), description: t.string(), executor: t.string() },
  (ctx, { warningId, stepNumber, description, executor }) => {
    const w = ctx.db.warning.id.find(warningId);
    if (!w) throw new SenderError('Warning not found');
    // If the tech already finished before the plan arrived, their steps count as done.
    const doneAlready = executor === 'tech' && (w.status === 'fixing' || w.status === 'resolved');
    ctx.db.task.insert({ id: 0n, warningId, stepNumber, description, executor, status: doneAlready ? 'done' : 'pending', result: '' });
  }
);

export const updateTask = spacetimedb.reducer({ taskId: t.u64(), status: t.string(), result: t.string() }, (ctx, { taskId, status, result }) => {
  const row = ctx.db.task.id.find(taskId);
  if (!row) throw new SenderError('Task not found');
  ctx.db.task.id.update({ ...row, status, result });
});

// The agent rewrites a pending handoff's brief (only before anyone has signed it).
export const updateHandoffBrief = spacetimedb.reducer({ handoffId: t.u64(), brief: t.string() }, (ctx, { handoffId, brief }) => {
  const h = ctx.db.handoff.id.find(handoffId);
  if (!h) throw new SenderError('Handoff not found');
  if (h.fromSignedAt !== undefined || h.toSignedAt !== undefined) return; // never change what someone signed
  ctx.db.handoff.id.update({ ...h, brief });
});

// ─────────────────────────────────────────────────────────────
// Handoffs
// ─────────────────────────────────────────────────────────────

export const createHandoff = spacetimedb.reducer(
  { fromTechId: t.u64(), toTechId: t.u64(), brief: t.string() },
  (ctx, { fromTechId, toTechId, brief }) => {
    requireTech(ctx, fromTechId);
    requireTech(ctx, toTechId);
    if (fromTechId === toTechId) throw new SenderError('Pick a different tech');
    const open = [...ctx.db.warning.iter()].filter(w => w.status !== 'resolved' && w.claimedBy === fromTechId);
    const fallback = open.length ? open.map(w => `• ${w.rackId} (${w.kind}, ${w.severity}, ${w.status}): ${w.message}`).join('\n') : 'No open warnings.';
    ctx.db.handoff.insert({
      id: 0n,
      fromTechId,
      toTechId,
      brief: brief.trim() || fallback,
      openWarningIds: open.map(w => w.id),
      createdAt: ctx.timestamp,
      fromSignedAt: undefined,
      toSignedAt: undefined,
      status: 'pending',
    });
  }
);

export const signHandoff = spacetimedb.reducer({ handoffId: t.u64(), techId: t.u64() }, (ctx, { handoffId, techId }) => {
  const h = ctx.db.handoff.id.find(handoffId);
  if (!h) throw new SenderError('Handoff not found');
  if (h.status === 'complete') throw new SenderError('Already complete');

  const next = { ...h };
  if (techId === h.fromTechId) next.fromSignedAt = ctx.timestamp;
  else if (techId === h.toTechId) next.toSignedAt = ctx.timestamp;
  else throw new SenderError('You are not part of this handoff');

  if (next.fromSignedAt !== undefined && next.toSignedAt !== undefined) {
    next.status = 'complete';
    for (const wid of h.openWarningIds) {
      const w = ctx.db.warning.id.find(wid);
      if (w && w.status !== 'resolved') ctx.db.warning.id.update({ ...w, claimedBy: h.toTechId });
    }
    const from = ctx.db.tech.id.find(h.fromTechId);
    const to = ctx.db.tech.id.find(h.toTechId);
    ctx.db.chainRecord.insert({
      id: 0n,
      kind: 'handoff',
      refId: h.id,
      techIds: [h.fromTechId, h.toTechId],
      summary: `${from?.name ?? '?'} handed off ${h.openWarningIds.length} open item(s) to ${to?.name ?? '?'}.`,
      createdAt: ctx.timestamp,
      txSignature: '',
    });
  }
  ctx.db.handoff.id.update(next);
});

// ─────────────────────────────────────────────────────────────
// Chain service hooks
// ─────────────────────────────────────────────────────────────

export const setTechWallet = spacetimedb.reducer({ techId: t.u64(), walletPubkey: t.string() }, (ctx, { techId, walletPubkey }) => {
  const row = requireTech(ctx, techId);
  ctx.db.tech.id.update({ ...row, walletPubkey });
});

export const setTxSignature = spacetimedb.reducer({ recordId: t.u64(), txSignature: t.string() }, (ctx, { recordId, txSignature }) => {
  const rec = ctx.db.chainRecord.id.find(recordId);
  if (!rec) throw new SenderError('Record not found');
  ctx.db.chainRecord.id.update({ ...rec, txSignature });
});

// ─────────────────────────────────────────────────────────────
// Demo controls
// ─────────────────────────────────────────────────────────────

export const breakRack = spacetimedb.reducer({ rackId: t.string(), fault: t.string() }, (ctx, { rackId, fault }) => {
  const r = ctx.db.rack.id.find(rackId);
  if (!r) throw new SenderError('Rack not found');
  if (fault === 'pdu') {
    // Simulate losing the A-side feed (a tripped breaker upstream, a bad PDU, a pulled cord).
    ctx.db.rack.id.update({ ...r, fault, pduAOnline: false });
    return;
  }
  if (!isSensorKind(fault)) throw new SenderError('Unknown fault type');
  ctx.db.rack.id.update({ ...r, fault });
});

export const breakCdu = spacetimedb.reducer({ cduId: t.string(), fault: t.string() }, (ctx, { cduId, fault }) => {
  const c = ctx.db.cdu.id.find(cduId);
  if (!c) throw new SenderError('CDU not found');
  if (fault !== 'pump' && fault !== 'leak') throw new SenderError('Unknown CDU fault');
  ctx.db.cdu.id.update({ ...c, fault });
});

export const resetDemo = spacetimedb.reducer(ctx => {
  for (const x of [...ctx.db.sensorReading.iter()]) ctx.db.sensorReading.id.delete(x.id);
  for (const x of [...ctx.db.task.iter()]) ctx.db.task.id.delete(x.id);
  for (const x of [...ctx.db.warning.iter()]) ctx.db.warning.id.delete(x.id);
  for (const x of [...ctx.db.handoff.iter()]) ctx.db.handoff.id.delete(x.id);
  for (const x of [...ctx.db.chainRecord.iter()]) ctx.db.chainRecord.id.delete(x.id);
  for (const x of [...ctx.db.rack.iter()]) ctx.db.rack.id.delete(x.id);
  for (const x of [...ctx.db.cduReading.iter()]) ctx.db.cduReading.id.delete(x.id);
  for (const x of [...ctx.db.cdu.iter()]) ctx.db.cdu.id.delete(x.id);
  // Keep techs (and their wallets); only add them if missing.
  if ([...ctx.db.tech.iter()].length === 0) seed(ctx);
  else seedRacks(ctx);
  startTimer(ctx);
});
