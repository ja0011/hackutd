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
    walletPubkey: t.string(), // Solana public key, filled in later
  }
);

// One row per rack, holding its latest state.
// status: 'ok' | 'warning' | 'critical'
const rack = table(
  { name: 'rack', public: true },
  {
    id: t.string().primaryKey(), // e.g. 'R-12'
    aisle: t.string(),
    temperatureF: t.f64(),
    powerKw: t.f64(),
    status: t.string(),
    failing: t.bool(), // demo switch: true = cooling is broken
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
    at: t.timestamp(),
  }
);

// A problem that someone has to own.
// severity: 'low' | 'medium' | 'critical'
// status: 'open' | 'claimed' | 'fixing' | 'resolved'
const warning = table(
  { name: 'warning', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    rackId: t.string().index('btree'),
    severity: t.string(),
    message: t.string(),
    status: t.string(),
    source: t.string(), // 'rule' | 'agent'
    createdAt: t.timestamp(),
    claimedBy: t.option(t.u64()),
    claimedAt: t.option(t.timestamp()),
    resolvedAt: t.option(t.timestamp()),
  }
);

// Plan steps for a warning (written by the Nemotron agent later).
// executor: 'agent' | 'tech'
// status: 'pending' | 'in_progress' | 'done' | 'failed'
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

// Shift handoff: both techs must sign.
// status: 'pending' | 'complete'
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
// kind: 'claim' | 'fix_verified' | 'handoff'
// txSignature stays empty until the Solana service writes it on-chain.
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

const spacetimedb = schema({
  tech,
  rack,
  sensorReading,
  warning,
  task,
  handoff,
  chainRecord,
  simTimer,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// ─────────────────────────────────────────────────────────────
// Simulator settings
// ─────────────────────────────────────────────────────────────

const TICK_MICROS = 3_000_000n; // one reading every 3 seconds
const BASELINE_F = 72;
const WARN_F = 82; // medium warning
const CRITICAL_F = 90; // critical warning
const VERIFIED_F = 78; // a fix only counts once temp is back under this
const KEEP_READINGS_PER_RACK = 40;

function seed(ctx: Ctx) {
  const techs = [
    { name: 'Alex Rivera', role: 'senior', shift: 'night' },
    { name: 'Jordan Lee', role: 'junior', shift: 'night' },
    { name: 'Sam Patel', role: 'senior', shift: 'day' },
    { name: 'Morgan Diaz', role: 'supervisor', shift: 'day' },
  ];
  for (const x of techs) ctx.db.tech.insert({ id: 0n, walletPubkey: '', ...x });

  const aisles = ['A', 'A', 'A', 'B', 'B', 'B', 'C', 'C', 'C'];
  aisles.forEach((aisle, i) => {
    ctx.db.rack.insert({
      id: `R-${String(i + 10)}`,
      aisle,
      temperatureF: BASELINE_F + ctx.random() * 3,
      powerKw: 8 + ctx.random() * 2,
      status: 'ok',
      failing: false,
    });
  });
}

function startTimer(ctx: Ctx) {
  for (const row of ctx.db.simTimer.iter()) ctx.db.simTimer.scheduledId.delete(row.scheduledId);
  ctx.db.simTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(TICK_MICROS) });
}

function severityFor(tempF: number): string {
  if (tempF >= CRITICAL_F) return 'critical';
  if (tempF >= WARN_F) return 'medium';
  return 'low';
}

function activeWarningFor(ctx: Ctx, rackId: string) {
  return [...ctx.db.warning.rackId.filter(rackId)].find(w => w.status !== 'resolved');
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
// Simulator tick: new readings, detection, fix verification
// ─────────────────────────────────────────────────────────────

export const simTick = spacetimedb.reducer(
  { onSchedule: simTimer },
  { timer: simTimer.rowType },
  (ctx, { timer: _timer }) => {
    for (const r of [...ctx.db.rack.iter()]) {
      // Broken cooling climbs fast; healthy cooling drifts back to baseline.
      let temp = r.temperatureF;
      if (r.failing) temp += 1.2 + ctx.random() * 0.8;
      else temp += (BASELINE_F - temp) * 0.25 + (ctx.random() - 0.5) * 0.8;
      const power = Math.max(5, r.powerKw + (ctx.random() - 0.5) * 0.3);

      const status = temp >= CRITICAL_F ? 'critical' : temp >= WARN_F ? 'warning' : 'ok';
      ctx.db.rack.id.update({ ...r, temperatureF: temp, powerKw: power, status });
      ctx.db.sensorReading.insert({ id: 0n, rackId: r.id, temperatureF: temp, powerKw: power, at: ctx.timestamp });

      // Prune old readings for this rack.
      const readings = [...ctx.db.sensorReading.rackId.filter(r.id)].sort((a, b) =>
        a.id < b.id ? -1 : 1
      );
      for (const old of readings.slice(0, Math.max(0, readings.length - KEEP_READINGS_PER_RACK))) {
        ctx.db.sensorReading.id.delete(old.id);
      }

      const active = activeWarningFor(ctx, r.id);

      // Rule-based detection (the Nemotron agent will add smarter early warnings).
      if (!active && temp >= WARN_F) {
        ctx.db.warning.insert({
          id: 0n,
          rackId: r.id,
          severity: severityFor(temp),
          message: `${r.id} is at ${temp.toFixed(1)}°F and rising. Cooling may be failing.`,
          status: 'open',
          source: 'rule',
          createdAt: ctx.timestamp,
          claimedBy: undefined,
          claimedAt: undefined,
          resolvedAt: undefined,
        });
      } else if (active && active.status !== 'fixing' && severityFor(temp) === 'critical' && active.severity !== 'critical') {
        // Escalate an existing warning if it got worse.
        ctx.db.warning.id.update({ ...active, severity: 'critical' });
      }

      // Verification: a fix only counts once the data says it worked.
      if (active && active.status === 'fixing' && temp < VERIFIED_F) {
        ctx.db.warning.id.update({ ...active, status: 'resolved', resolvedAt: ctx.timestamp });
        const owner = active.claimedBy;
        ctx.db.chainRecord.insert({
          id: 0n,
          kind: 'fix_verified',
          refId: active.id,
          techIds: owner === undefined ? [] : [owner],
          summary: `${r.id} back to ${temp.toFixed(1)}°F. Fix verified by sensor data.`,
          createdAt: ctx.timestamp,
          txSignature: '',
        });
      }
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Tech actions
// ─────────────────────────────────────────────────────────────

function requireTech(ctx: Ctx, techId: bigint) {
  const t0 = ctx.db.tech.id.find(techId);
  if (!t0) throw new SenderError('Unknown tech');
  return t0;
}

export const claimWarning = spacetimedb.reducer(
  { warningId: t.u64(), techId: t.u64() },
  (ctx, { warningId, techId }) => {
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
      summary: `${who.name} took ownership of the ${w.rackId} warning.`,
      createdAt: ctx.timestamp,
      txSignature: '',
    });
  }
);

// The tech says the physical fix is done. It is NOT resolved until the
// simulator sees the temperature come back down.
export const markFixed = spacetimedb.reducer(
  { warningId: t.u64(), techId: t.u64() },
  (ctx, { warningId, techId }) => {
    requireTech(ctx, techId);
    const w = ctx.db.warning.id.find(warningId);
    if (!w) throw new SenderError('Warning not found');
    if (w.claimedBy !== techId) throw new SenderError('Only the owner can mark this fixed');
    ctx.db.warning.id.update({ ...w, status: 'fixing' });
    const r = ctx.db.rack.id.find(w.rackId);
    if (r) ctx.db.rack.id.update({ ...r, failing: false });
  }
);

// Agent (or tech) adds a plan step to a warning.
export const addTask = spacetimedb.reducer(
  { warningId: t.u64(), stepNumber: t.u32(), description: t.string(), executor: t.string() },
  (ctx, { warningId, stepNumber, description, executor }) => {
    if (!ctx.db.warning.id.find(warningId)) throw new SenderError('Warning not found');
    ctx.db.task.insert({ id: 0n, warningId, stepNumber, description, executor, status: 'pending', result: '' });
  }
);

export const updateTask = spacetimedb.reducer(
  { taskId: t.u64(), status: t.string(), result: t.string() },
  (ctx, { taskId, status, result }) => {
    const row = ctx.db.task.id.find(taskId);
    if (!row) throw new SenderError('Task not found');
    ctx.db.task.id.update({ ...row, status, result });
  }
);

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
    // Everything the outgoing tech still owns moves with the handoff.
    const fallback = open.length
      ? open.map(w => `• ${w.rackId} (${w.severity}, ${w.status}): ${w.message}`).join('\n')
      : 'No open warnings.';
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

export const signHandoff = spacetimedb.reducer(
  { handoffId: t.u64(), techId: t.u64() },
  (ctx, { handoffId, techId }) => {
    const h = ctx.db.handoff.id.find(handoffId);
    if (!h) throw new SenderError('Handoff not found');
    if (h.status === 'complete') throw new SenderError('Already complete');

    let next = { ...h };
    if (techId === h.fromTechId) next.fromSignedAt = ctx.timestamp;
    else if (techId === h.toTechId) next.toSignedAt = ctx.timestamp;
    else throw new SenderError('You are not part of this handoff');

    if (next.fromSignedAt !== undefined && next.toSignedAt !== undefined) {
      next.status = 'complete';
      // Ownership of open warnings moves to the incoming tech.
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
  }
);

// Filled in by the Solana service after it writes a record on-chain.
export const setTxSignature = spacetimedb.reducer(
  { recordId: t.u64(), txSignature: t.string() },
  (ctx, { recordId, txSignature }) => {
    const rec = ctx.db.chainRecord.id.find(recordId);
    if (!rec) throw new SenderError('Record not found');
    ctx.db.chainRecord.id.update({ ...rec, txSignature });
  }
);

// ─────────────────────────────────────────────────────────────
// Demo controls
// ─────────────────────────────────────────────────────────────

export const breakRack = spacetimedb.reducer({ rackId: t.string() }, (ctx, { rackId }) => {
  const r = ctx.db.rack.id.find(rackId);
  if (!r) throw new SenderError('Rack not found');
  ctx.db.rack.id.update({ ...r, failing: true });
});

export const resetDemo = spacetimedb.reducer(ctx => {
  for (const x of [...ctx.db.sensorReading.iter()]) ctx.db.sensorReading.id.delete(x.id);
  for (const x of [...ctx.db.task.iter()]) ctx.db.task.id.delete(x.id);
  for (const x of [...ctx.db.warning.iter()]) ctx.db.warning.id.delete(x.id);
  for (const x of [...ctx.db.handoff.iter()]) ctx.db.handoff.id.delete(x.id);
  for (const x of [...ctx.db.chainRecord.iter()]) ctx.db.chainRecord.id.delete(x.id);
  for (const x of [...ctx.db.rack.iter()]) ctx.db.rack.id.delete(x.id);
  for (const x of [...ctx.db.tech.iter()]) ctx.db.tech.id.delete(x.id);
  seed(ctx);
  startTimer(ctx);
});
