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

// ── Escalation: skills, history, tenants, incidents, pages ────────────────
// These are separate tables (not new columns on `tech`) so a republish keeps existing data.

// What each tech is good at. skills: comma list of cooling | electrical | network | general | all
const techProfile = table(
  { name: 'tech_profile', public: true },
  {
    techId: t.u64().primaryKey(),
    skills: t.string(),
  }
);

// Past fixes (seeded team history). Used to rank who should be paged for a given kind of fault.
const pastFix = table(
  { name: 'past_fix', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    techId: t.u64().index('btree'),
    kind: t.string(),
    minutes: t.u32(),
    daysAgo: t.u32(),
    summary: t.string(),
  }
);

// Which shift is on the floor right now (demo can flip it).
const floor = table({ name: 'floor', public: true }, { id: t.string().primaryKey(), currentShift: t.string() });

// Sample tenants (demo data). Each rents some racks. flagLevel: 0 none, 1 watch, 2 hot.
const tenant = table(
  { name: 'tenant', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    workload: t.string(),
    tier: t.string(), // 'critical' | 'standard' | 'best-effort'
    slaPct: t.f64(),
    downtimeCostPerHour: t.f64(), // ASSUMED rate used for the cost estimate
    rackIds: t.string(), // comma list
    flagLevel: t.u32(),
    flagNote: t.string(),
  }
);

// One row per active warning: how urgent it is, who it hurts, what it costs, and the routing decision.
const incident = table(
  { name: 'incident', public: true },
  {
    warningId: t.u64().primaryKey(),
    basePriority: t.string(),
    priority: t.string(), // after customer-sensitivity bump or supervisor override
    bumpReason: t.string(),
    overriddenBy: t.option(t.u64()),
    minutesToCritical: t.f64(), // -1 = no deadline detected
    affectedRacks: t.string(),
    tenants: t.string(),
    costPerMinute: t.f64(),
    slaAtRisk: t.bool(),
    ifUnfixed: t.string(),
    similarFix: t.string(),
    mode: t.string(), // 'page_now' | 'holding'
    decision: t.string(),
  }
);

// The paging chain. status: queued | paging | acknowledged | missed | declined | skipped | superseded
const page = table(
  { name: 'page', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    warningId: t.u64().index('btree'),
    techId: t.u64(),
    round: t.u32(),
    status: t.string(),
    pagedAt: t.timestamp(),
    ackAt: t.option(t.timestamp()),
    timeoutSec: t.u32(),
    reason: t.string(),
  }
);

// Nemotron's grounded root-cause analysis for a warning.
const analysis = table(
  { name: 'analysis', public: true },
  {
    warningId: t.u64().primaryKey(),
    rootCause: t.string(),
    evidence: t.string(),
    runbook: t.string(), // e.g. "RB-CDU-01 step 3: ..."
    confidence: t.u32(), // 0-100
    callSenior: t.bool(),
    createdAt: t.timestamp(),
  }
);

// Hash links: each on-chain record carries the fingerprint of the record before it in the same
// incident, so deleting or editing any event later breaks the chain. Written by the chain service.
const chainLink = table(
  { name: 'chain_link', public: true },
  {
    recordId: t.u64().primaryKey(),
    chainKey: t.string(), // 'w:<warningId>' or 'h:<handoffId>'
    sha256: t.string(),
    prevSha256: t.string(), // '' for the first record in the chain
  }
);

// With/without comparison: the same fault twice, one never paged (the old way), one with Night Watch.
const experiment = table(
  { name: 'experiment', public: true },
  {
    id: t.string().primaryKey(), // 'main'
    active: t.bool(),
    startedAt: t.timestamp(),
    baselineCdu: t.string(),
    pagedCdu: t.string(),
    baselineWarningId: t.u64(), // 0 until the warning appears
    pagedWarningId: t.u64(),
  }
);

// Live news about a tenant (via an illustrative stand-in company), scored by Nemotron. Written by the agent.
const tenantSignal = table(
  { name: 'tenant_signal', public: true },
  {
    tenantId: t.u64().primaryKey(),
    company: t.string(),
    headline: t.string(),
    url: t.string(),
    source: t.string(),
    publishedAt: t.string(),
    score: t.u32(), // 0 none, 1 watch, 2 hot
    note: t.string(),
    checkedAt: t.timestamp(),
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

const spacetimedb = schema({ tech, rack, sensorReading, cdu, cduReading, warning, task, handoff, chainRecord, techProfile, pastFix, floor, tenant, incident, page, analysis, chainLink, experiment, tenantSignal, simTimer });
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
  seedTeam(ctx);
  seedRacks(ctx);
}

// ── Team, history and tenants (idempotent: safe to run on a database that already has some of it) ──
const TEAM = [
  { name: 'Alex Rivera', role: 'senior', shift: 'night', skills: 'cooling' },
  { name: 'Jordan Lee', role: 'junior', shift: 'night', skills: 'general' },
  { name: 'Sam Patel', role: 'senior', shift: 'day', skills: 'electrical' },
  { name: 'Morgan Diaz', role: 'supervisor', shift: 'day', skills: 'all' },
  { name: 'Priya Nair', role: 'mid', shift: 'night', skills: 'cooling' },
  { name: 'Marcus Chen', role: 'mid', shift: 'night', skills: 'electrical' },
  { name: 'Elena Voss', role: 'senior', shift: 'day', skills: 'network' },
];

// [tech, kind, minutes to fix, days ago, what was done]
const HISTORY: [string, string, number, number, string][] = [
  ['Alex Rivera', 'cdu', 11, 6, 'CDU-B pump seized: swapped the pump cartridge and bled the loop'],
  ['Alex Rivera', 'cdu', 14, 19, 'CDU-A flow loss from a clogged strainer: cleaned it, flow restored'],
  ['Alex Rivera', 'cdu', 11, 41, 'CDU-C pump controller fault: power-cycled it and replaced the fuse'],
  ['Alex Rivera', 'cooling', 9, 12, 'R-12 fan tray failed: replaced the fan tray'],
  ['Priya Nair', 'cdu', 19, 30, 'CDU-A low pressure: topped up coolant and bled trapped air'],
  ['Priya Nair', 'cooling', 12, 8, 'R-16 blocked intake: cleared the blanking panel and reseated the baffle'],
  ['Priya Nair', 'cooling', 15, 25, 'R-11 hot spot: re-aimed the perforated tile and fixed airflow'],
  ['Jordan Lee', 'humidity', 8, 10, 'Aisle B humidity: closed a door seal and reset the humidifier'],
  ['Jordan Lee', 'disk', 14, 22, 'R-15 disk errors: reseated the drive and swapped a cable'],
  ['Sam Patel', 'pdu', 8, 3, 'R-14 lost PDU A: reset the upstream breaker and reseated the cord'],
  ['Sam Patel', 'pdu', 9, 15, 'R-17 PDU B offline: replaced a failed PDU input module'],
  ['Sam Patel', 'pdu', 10, 27, 'R-10 PDU A tripped: rebalanced load across both feeds'],
  ['Sam Patel', 'pdu', 9, 50, 'R-13 PDU B cord damaged: replaced the power cord'],
  ['Sam Patel', 'power', 13, 9, 'R-12 power spike: moved two servers to another circuit'],
  ['Marcus Chen', 'pdu', 16, 21, 'R-18 PDU A offline: reseated the feed and cleared the fault'],
  ['Marcus Chen', 'power', 11, 14, 'R-15 power draw high: rebalanced the load'],
  ['Elena Voss', 'network', 10, 5, 'R-11 packet loss: replaced a faulty optic'],
  ['Elena Voss', 'network', 12, 18, 'R-16 packet loss: swapped a damaged fiber patch'],
  ['Elena Voss', 'network', 9, 40, 'R-13 packet loss: reseated the uplink'],
  ['Elena Voss', 'disk', 15, 22, 'R-18 disk errors: replaced a failing drive'],
];

// Sample tenants (demo data, NOT real customers). downtimeCostPerHour is an assumed rate.
const TENANTS = [
  { name: 'Apex Racing Dynamics', workload: 'F1-style aerodynamics simulation', tier: 'critical', slaPct: 99.95, downtimeCostPerHour: 42000, rackIds: 'R-10,R-11', flagLevel: 2, flagNote: 'had an SLA breach 9 days ago' },
  { name: 'Helix Therapeutics', workload: 'Drug discovery model training', tier: 'critical', slaPct: 99.99, downtimeCostPerHour: 65000, rackIds: 'R-12,R-13', flagLevel: 2, flagNote: 'has an open complaint about last month’s outage' },
  { name: 'Sentinel Pay', workload: 'Fraud model inference', tier: 'critical', slaPct: 99.99, downtimeCostPerHour: 90000, rackIds: 'R-14', flagLevel: 0, flagNote: '' },
  { name: 'Meridian Weather Lab', workload: 'Climate simulation', tier: 'standard', slaPct: 99.9, downtimeCostPerHour: 18000, rackIds: 'R-15,R-16', flagLevel: 0, flagNote: '' },
  { name: 'Orbit Labs', workload: 'LLM fine-tuning', tier: 'standard', slaPct: 99.9, downtimeCostPerHour: 30000, rackIds: 'R-17', flagLevel: 1, flagNote: 'escalated to management last month' },
  { name: 'Northgate University', workload: 'Research cluster', tier: 'best-effort', slaPct: 99.0, downtimeCostPerHour: 6000, rackIds: 'R-18', flagLevel: 0, flagNote: '' },
];

function seedTeam(ctx: Ctx) {
  for (const m of TEAM) {
    let row = [...ctx.db.tech.iter()].find(x => x.name === m.name);
    if (!row) row = ctx.db.tech.insert({ id: 0n, name: m.name, role: m.role, shift: m.shift, walletPubkey: '' });
    if (!ctx.db.techProfile.techId.find(row.id)) ctx.db.techProfile.insert({ techId: row.id, skills: m.skills });
  }
  if ([...ctx.db.pastFix.iter()].length === 0) {
    for (const [name, kind, minutes, daysAgo, summary] of HISTORY) {
      const who = [...ctx.db.tech.iter()].find(x => x.name === name);
      if (who) ctx.db.pastFix.insert({ id: 0n, techId: who.id, kind, minutes, daysAgo, summary });
    }
  }
  if ([...ctx.db.tenant.iter()].length === 0) for (const x of TENANTS) ctx.db.tenant.insert({ id: 0n, ...x });
  if (!ctx.db.floor.id.find('main')) ctx.db.floor.insert({ id: 'main', currentShift: 'night' });
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
  for (const tk of [...ctx.db.task.warningId.filter(w.id)]) {
    if (tk.executor === 'agent' && tk.status !== 'done' && tk.description.startsWith('Confirm')) ctx.db.task.id.update({ ...tk, status: 'done', result: summary });
  }
  ctx.db.warning.id.update({ ...w, status: 'resolved', resolvedAt: ctx.timestamp, verifiedBy: verifiedBy ?? w.verifiedBy });
  ctx.db.chainRecord.insert({ id: 0n, kind: 'fix_verified', refId: w.id, techIds, summary, createdAt: ctx.timestamp, txSignature: '' });
}

// ─────────────────────────────────────────────────────────────
// Incident engine: time-to-impact, cost, priority, and who gets paged
// ─────────────────────────────────────────────────────────────

type Warning = NonNullable<ReturnType<Ctx['db']['warning']['id']['find']>>;
type Incident = NonNullable<ReturnType<Ctx['db']['incident']['warningId']['find']>>;

const SIM_SEC_PER_TICK = 3; // real time: one reading every 3 seconds, so 'minutes to critical' are real minutes
const HOLD_BELOW_MIN = 10; // closer than this to critical: never wait for the best person
const HOLD_GAP = 4;
const AUTO_GRACE_SEC = 30; // how long the agent gets to fix a runaway job before a tech is paged // wait for an off-shift expert only if they beat the best on-shift tech by this much
const ACK_TIMEOUT_SEC: Record<string, number> = { critical: 45, medium: 60, low: 90 };
const LEVELS = ['low', 'medium', 'critical'];
const NEEDED_SKILL: Record<string, string> = { cdu: 'cooling', cooling: 'cooling', humidity: 'cooling', pdu: 'electrical', power: 'electrical', network: 'network', disk: 'general', reported: 'general' };
const KIND_TITLE: Record<string, string> = { cdu: 'coolant flow loss', cooling: 'overheating', power: 'power draw', disk: 'disk errors', network: 'packet loss', humidity: 'humidity', pdu: 'PDU feed loss', reported: 'reported issue' };

const byId = (a: { id: bigint }, b: { id: bigint }) => (a.id < b.id ? -1 : 1);
const money = (x: number) => '$' + String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const secondsBetween = (a: { microsSinceUnixEpoch: bigint }, b: { microsSinceUnixEpoch: bigint }) => Number(b.microsSinceUnixEpoch - a.microsSinceUnixEpoch) / 1e6;

// Median change per reading over the last few readings (one sudden jump doesn't count as a trend).
function trendPerTick(xs: number[]) {
  const d: number[] = [];
  for (let i = Math.max(1, xs.length - 8); i < xs.length; i++) d.push(xs[i] - xs[i - 1]);
  if (d.length < 3) return 0; // too few readings to call it a trend
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}
const ticksToMin = (ticks: number) => (ticks * SIM_SEC_PER_TICK) / 60;
// '40 s' under a minute, otherwise '3 min'.
const fmtEta = (min: number) => (min < 1 ? `${Math.max(5, Math.round((min * 60) / 5) * 5)} s` : `${Math.round(min)} min`);
// Smallest change per reading that counts as a real trend (anything less is sensor noise).
const MIN_TREND: Record<SensorKind, number> = { cooling: 0.15, power: 0.08, disk: 0.5, network: 0.08, humidity: 0.2, pdu: 1.5 };

// Rack overheating in an aisle whose CDU is failing is a symptom, not a separate incident,
// even if the CDU's own alarm hasn't fired yet (its flow is already below normal).
function rootCauseCdu(ctx: Ctx, w: Warning): { rackId: string } | undefined {
  if (w.kind !== 'cooling') return undefined;
  const r = ctx.db.rack.id.find(w.rackId);
  if (!r) return undefined;
  const id = `CDU-${r.aisle}`;
  if ([...ctx.db.warning.rackId.filter(id)].some(x => x.kind === 'cdu' && x.status !== 'resolved')) return { rackId: id };
  const c = ctx.db.cdu.id.find(id);
  return c && (c.flowLpm < CDU.flow.ok || c.pressureKpa < CDU.pressure.ok) ? { rackId: id } : undefined;
}

function rackSeries(ctx: Ctx, rackId: string, kind: SensorKind) {
  const rows = [...ctx.db.sensorReading.rackId.filter(rackId)].sort(byId).slice(-10);
  return rows.map(x => SENSORS[kind].read(x as unknown as Rack));
}

// Minutes until a rack sensor reaches its critical limit at the current trend. 0 = already there, -1 = no deadline.
function rackEta(ctx: Ctx, rackId: string, kind: SensorKind): number {
  const r = ctx.db.rack.id.find(rackId);
  if (!r) return -1;
  const s = SENSORS[kind];
  const now = s.read(r);
  if (r.status === 'down' || now >= s.crit) return 0;
  const slope = trendPerTick(rackSeries(ctx, rackId, kind));
  if (slope <= MIN_TREND[kind]) return -1; // normal sensor noise, not a trend
  return ticksToMin((s.crit - now) / slope);
}

function incidentEta(ctx: Ctx, w: Warning): number {
  const cands: number[] = [];
  if (w.kind === 'cdu') {
    const c = ctx.db.cdu.id.find(w.rackId);
    if (!c) return -1;
    if (cduLevel(c) === 'critical') return 0;
    const rs = [...ctx.db.cduReading.cduId.filter(c.id)].sort(byId).slice(-10);
    const fs = trendPerTick(rs.map(x => x.flowLpm));
    const ps = trendPerTick(rs.map(x => x.pressureKpa));
    if (fs < -0.05) cands.push(ticksToMin((c.flowLpm - CDU.flow.crit) / -fs));
    if (ps < -0.05) cands.push(ticksToMin((c.pressureKpa - CDU.pressure.crit) / -ps));
    for (const r of ctx.db.rack.iter()) if (r.aisle === c.aisle) {
      const e = rackEta(ctx, r.id, 'cooling');
      if (e >= 0) cands.push(e);
    }
  } else if (isSensorKind(w.kind)) {
    const e = rackEta(ctx, w.rackId, w.kind);
    if (e >= 0) cands.push(e);
  } else {
    const r = ctx.db.rack.id.find(w.rackId);
    if (r?.status === 'down') return 0;
  }
  return cands.length ? Math.min(...cands) : -1;
}

function affectedRackIds(ctx: Ctx, w: Warning): string[] {
  if (w.kind === 'cdu') {
    const c = ctx.db.cdu.id.find(w.rackId);
    return c ? [...ctx.db.rack.iter()].filter(r => r.aisle === c.aisle).map(r => r.id) : [];
  }
  return [w.rackId];
}

function techHistory(ctx: Ctx, techId: bigint, kind: string) {
  const fixes = [...ctx.db.pastFix.techId.filter(techId)].filter(f => f.kind === kind);
  const avg = fixes.length ? Math.round(fixes.reduce((a, f) => a + f.minutes, 0) / fixes.length) : 0;
  let live = 0; // fixes done during this run also count toward experience
  for (const w of ctx.db.warning.iter()) if (w.status === 'resolved' && w.kind === kind && w.claimedBy === techId) live++;
  return { n: fixes.length + live, avg };
}

// Everyone except supervisors, best match first: skill fit, then how many similar faults they have fixed.
function rankTechs(ctx: Ctx, kind: string) {
  const needed = NEEDED_SKILL[kind] ?? 'general';
  return [...ctx.db.tech.iter()]
    .filter(tc => tc.role !== 'supervisor')
    .map(tc => {
      const skills = (ctx.db.techProfile.techId.find(tc.id)?.skills ?? 'general').split(',');
      const h = techHistory(ctx, tc.id, kind);
      const fit = skills.includes(needed) ? 10 : skills.includes('general') ? 3 : 0;
      const seniority = tc.role === 'senior' ? 2 : tc.role === 'mid' ? 1 : 0;
      const score = fit + 3 * h.n + seniority - h.avg * 0.05;
      const label = kind === 'reported' ? 'issue' : `${KIND_TITLE[kind] ?? kind}`;
      const fitText = fit === 10 ? `${needed} specialist` : fit === 3 ? 'generalist' : `no ${needed} skills`;
      const histText = h.n ? `${h.n} past ${label} fix${h.n > 1 ? 'es' : ''}${h.avg ? `, avg ${h.avg} min` : ''}` : `no past ${label} fixes`;
      return { tech: tc, score, hist: h, why: `${fitText}, ${histText}` };
    })
    .sort((a, b) => b.score - a.score);
}

function currentShift(ctx: Ctx) {
  return ctx.db.floor.id.find('main')?.currentShift ?? 'night';
}

// Recompute urgency, impact and priority for every unresolved warning (runs every tick).
function updateIncidents(ctx: Ctx) {
  const tenants = [...ctx.db.tenant.iter()];
  for (const w of [...ctx.db.warning.iter()]) {
    const existing = ctx.db.incident.warningId.find(w.id);
    if (w.status === 'resolved' && existing) {
      // Keep the incident as a record of what happened, frozen at the moment it was resolved.
      if (existing.mode !== 'resolved') {
        const act = w.claimedBy === undefined ? [...ctx.db.chainRecord.iter()].find(r => r.refId === w.id && r.kind === 'agent_action') : undefined;
        const decision = act ? `Fixed by the Nemotron agent ${Math.round(secondsBetween(w.createdAt, act.createdAt))}s after the alert. Nobody was paged.` : existing.decision;
        ctx.db.incident.warningId.update({ ...existing, mode: 'resolved', minutesToCritical: -1, decision });
      }
      continue;
    }
    if (existing?.mode === 'acknowledged') continue; // someone owns it; keep the routing record as it was
    const racks = affectedRackIds(ctx, w);
    const eta = incidentEta(ctx, w);

    // Who is exposed, and what does an hour of downtime cost them (assumed rates)?
    const hit: { t: (typeof tenants)[number]; share: number }[] = [];
    for (const tn of tenants) {
      const mine = tn.rackIds.split(',');
      const overlap = mine.filter(id => racks.includes(id)).length;
      if (overlap) hit.push({ t: tn, share: overlap / mine.length });
    }
    const costPerMinute = hit.reduce((a, x) => a + (x.t.downtimeCostPerHour / 60) * x.share, 0);
    const slaAtRisk = hit.some(x => x.t.tier === 'critical');

    // Customer sensitivity: an easy fix on a customer who is already upset gets bumped up.
    // Two sources: the account history (flagLevel) and live news scored by Nemotron (tenant_signal).
    const base = LEVELS.includes(w.severity) ? w.severity : 'medium';
    let bump = 0;
    let bumpReason = '';
    for (const x of hit) {
      const sig = ctx.db.tenantSignal.tenantId.find(x.t.id);
      const newsWins = !!sig && sig.score > x.t.flagLevel;
      const level = Math.min(2, newsWins ? sig!.score : x.t.flagLevel);
      const b = Math.max(0, level - (x.t.tier === 'critical' ? 0 : 1));
      if (b > bump) {
        bump = b;
        bumpReason = newsWins
          ? `${x.t.name} (${x.t.tier} tier): live news via stand-in ${sig!.company}: "${sig!.headline}" (${sig!.source}). ${sig!.note.replace(/\.$/, "")}`
          : `${x.t.name} (${x.t.tier} tier) ${x.t.flagNote}`;
      }
    }
    let priority = LEVELS[Math.min(2, LEVELS.indexOf(base) + bump)];
    const overriddenBy = existing?.overriddenBy;
    if (overriddenBy !== undefined && existing) priority = existing.priority;
    const reason = overriddenBy !== undefined && existing ? existing.bumpReason : priority !== base ? `Raised ${base} to ${priority}: ${bumpReason}.` : '';

    const n = racks.length;
    const when =
      eta === 0 ? 'Already at the critical limit.'
      : eta > 0 ? `At the current rate it reaches critical in about ${fmtEta(eta)}.`
      : w.kind === 'pdu' ? 'No deadline yet, but the rack has no backup power: one more fault or a load rise takes it offline.'
      : 'No clear trend yet.';
    const who = hit.length ? `${n} rack${n > 1 ? 's' : ''} and ${hit.map(x => x.t.name).join(', ')} exposed, about ${money(costPerMinute * 10)} per 10 min of downtime (assumed rates).` : `${n} rack${n > 1 ? 's' : ''} exposed.`;
    const ifUnfixed = `${when} ${who}`;

    // The most similar past fix, taken from whoever has the best record for this kind of fault.
    let similarFix = existing?.similarFix ?? '';
    if (!existing) {
      const best = rankTechs(ctx, w.kind).find(x => x.hist.n > 0);
      const f = best ? [...ctx.db.pastFix.techId.filter(best.tech.id)].filter(p => p.kind === w.kind).sort((a, b) => a.daysAgo - b.daysAgo)[0] : undefined;
      if (best && f) similarFix = `${best.tech.name}, ${f.daysAgo} days ago: ${f.summary} (took ${f.minutes} min)`;
    }

    const row: Incident = {
      warningId: w.id,
      basePriority: base,
      priority,
      bumpReason: reason,
      overriddenBy,
      minutesToCritical: eta,
      affectedRacks: racks.join(', '),
      tenants: hit.map(x => x.t.name).join(', '),
      costPerMinute,
      slaAtRisk,
      ifUnfixed,
      similarFix,
      mode: existing?.mode ?? 'page_now',
      decision: existing?.decision ?? '',
    };
    if (w.status === 'resolved') {
      const act = [...ctx.db.chainRecord.iter()].find(r => r.refId === w.id && r.kind === 'agent_action');
      row.mode = 'resolved';
      row.minutesToCritical = -1;
      row.decision = act ? `Fixed by the Nemotron agent ${Math.round(secondsBetween(w.createdAt, act.createdAt))}s after the alert. Nobody was paged.` : row.decision;
    }
    if (existing) ctx.db.incident.warningId.update(row);
    else ctx.db.incident.insert(row);
  }
}

// A moment that gets written to Solana by the chain service.
function chainRec(ctx: Ctx, kind: string, refId: bigint, techIds: bigint[], summary: string) {
  ctx.db.chainRecord.insert({ id: 0n, kind, refId, techIds, summary, createdAt: ctx.timestamp, txSignature: '' });
}
const techName = (ctx: Ctx, id: bigint) => ctx.db.tech.id.find(id)?.name ?? 'unknown';
const incidentLabel = (w: Warning) => `${w.rackId} ${KIND_TITLE[w.kind] ?? w.kind}`;

// Link the comparison's two CDU warnings once they appear.
function linkExperiment(ctx: Ctx) {
  const ex = ctx.db.experiment.id.find('main');
  if (!ex || !ex.active || (ex.baselineWarningId && ex.pagedWarningId)) return;
  const find = (cduId: string) =>
    [...ctx.db.warning.rackId.filter(cduId)].find(w => w.kind === 'cdu' && w.createdAt.microsSinceUnixEpoch >= ex.startedAt.microsSinceUnixEpoch)?.id ?? 0n;
  const b = ex.baselineWarningId || find(ex.baselineCdu);
  const p = ex.pagedWarningId || find(ex.pagedCdu);
  if (b !== ex.baselineWarningId || p !== ex.pagedWarningId) ctx.db.experiment.id.update({ ...ex, baselineWarningId: b, pagedWarningId: p });
}
function isBaseline(ctx: Ctx, warningId: bigint) {
  const ex = ctx.db.experiment.id.find('main');
  return !!ex && ex.active && ex.baselineWarningId === warningId;
}

// The paging chain: page the best match, escalate if nobody acknowledges, or hold for the best person when it can wait.
function runEscalation(ctx: Ctx) {
  const shift = currentShift(ctx);
  for (const w of [...ctx.db.warning.iter()]) {
    const pages = [...ctx.db.page.warningId.filter(w.id)].sort(byId);
    // Fixed by the agent itself: nobody needs to be paged.
    if (w.status !== 'open' && w.claimedBy === undefined && w.kind === 'power') {
      for (const p of pages) if (p.status === 'paging' || p.status === 'queued') ctx.db.page.id.update({ ...p, status: 'skipped' });
      const inc0 = ctx.db.incident.warningId.find(w.id);
      const act = [...ctx.db.chainRecord.iter()].find(r => r.refId === w.id && r.kind === 'agent_action');
      const d = `Fixed by the Nemotron agent ${act ? Math.round(secondsBetween(w.createdAt, act.createdAt)) : 0}s after the alert. Nobody was paged.`;
      if (inc0 && inc0.mode !== 'resolved' && inc0.decision !== d) ctx.db.incident.warningId.update({ ...inc0, mode: inc0.mode === 'resolved' ? 'resolved' : 'auto', decision: d });
      continue;
    }
    if (w.status !== 'open') {
      for (const p of pages) if (p.status === 'paging' || p.status === 'queued') ctx.db.page.id.update({ ...p, status: 'skipped' });
      // Replace the "Paging X" line with who took it and how long it took.
      const inc = ctx.db.incident.warningId.find(w.id);
      if (inc && inc.mode !== 'acknowledged' && inc.mode !== 'resolved' && inc.mode !== 'symptom') {
        const owner = w.claimedBy !== undefined ? ctx.db.tech.id.find(w.claimedBy)?.name ?? 'a tech' : 'a tech';
        const secs = w.claimedAt ? Math.round(secondsBetween(w.createdAt, w.claimedAt)) : 0;
        const missed = pages.filter(p => p.status === 'missed' || p.status === 'declined').length;
        const viaPage = pages.some(p => p.techId === w.claimedBy && p.status === 'acknowledged');
        ctx.db.incident.warningId.update({
          ...inc,
          mode: 'acknowledged',
          decision: `${owner} took it ${secs}s after the alert${viaPage ? ' when paged' : ' directly from the dashboard'}${missed ? `, after ${missed} page${missed > 1 ? 's' : ''} went unanswered` : ''}.`,
        });
      }
      continue;
    }
    const inc = ctx.db.incident.warningId.find(w.id);
    if (!inc) continue;

    // Comparison baseline: the old way. The alert just sits on the dashboard; nobody is told.
    // Hold paging while the agent can still fix it: the first 30 s, or until power nears the warning line.
    const kw = ctx.db.rack.id.find(w.rackId)?.powerKw ?? 99;
    if (w.kind === 'power' && (kw < 13 || (secondsBetween(w.createdAt, ctx.timestamp) < AUTO_GRACE_SEC && kw < 14))) {
      const d = `The Nemotron agent is fixing this itself (moving the runaway job to a rack with spare power). A tech is paged only if it hasn't worked within ${AUTO_GRACE_SEC}s.`;
      if (inc.mode !== 'auto') ctx.db.incident.warningId.update({ ...inc, mode: 'auto', decision: d });
      continue;
    }
    if (isBaseline(ctx, w.id)) {
      const d = 'Not paged: this is the comparison baseline (the old way). The alert waits on the dashboard until someone happens to notice it.';
      if (inc.mode !== 'baseline') ctx.db.incident.warningId.update({ ...inc, mode: 'baseline', decision: d });
      continue;
    }

    // Symptom of a failing CDU: the CDU page covers it, so nobody gets paged twice.
    const cause = rootCauseCdu(ctx, w);
    if (cause) {
      for (const p of pages) if (p.status === 'paging' || p.status === 'queued') ctx.db.page.id.update({ ...p, status: 'superseded' });
      const d = `Symptom of ${cause.rackId} coolant loss (root cause). Covered by that page, not paged separately. Clears when ${cause.rackId} is fixed.`;
      if (inc.mode !== 'symptom' || inc.decision !== d) ctx.db.incident.warningId.update({ ...inc, mode: 'symptom', decision: d });
      continue;
    }

    const eta = inc.minutesToCritical;
    const urgent = inc.priority === 'critical' || (eta >= 0 && eta <= HOLD_BELOW_MIN);
    const ranked = rankTechs(ctx, w.kind);
    const onShift = ranked.filter(x => x.tech.shift === shift);
    const best = ranked[0];
    const bestOn = onShift[0];
    // Once a real page has gone out, never go back to waiting.
    const alreadyPaged = pages.some(p => p.timeoutSec > 0);
    const wantHold = !alreadyPaged && !urgent && !!best && best.tech.shift !== shift && (!bestOn || best.score - bestOn.score >= HOLD_GAP);

    let active = pages.find(p => p.status === 'paging' || p.status === 'queued');

    if (wantHold && best) {
      if (!active || active.techId !== best.tech.id) {
        if (active) ctx.db.page.id.update({ ...active, status: 'superseded' });
        const why = `${best.tech.name} (${best.tech.shift} shift): ${best.why}`;
        ctx.db.page.insert({ id: 0n, warningId: w.id, techId: best.tech.id, round: 0, status: 'queued', pagedAt: ctx.timestamp, ackAt: undefined, timeoutSec: 0, reason: `best match: ${best.why}` });
        chainRec(ctx, 'page_held', w.id, [], `${incidentLabel(w)} held for ${best.tech.name} (${best.tech.shift} shift, ${best.why}) instead of paging now.`);
        const alt = bestOn ? ` Best on-shift option is ${bestOn.tech.name} (${bestOn.why}).` : '';
        ctx.db.incident.warningId.update({ ...inc, mode: 'holding', decision: `Holding for ${why}.${alt} It can wait: ${eta < 0 ? 'no deadline detected' : `${fmtEta(eta)} to critical`}. Will page the on-shift team if it worsens or gets within ${HOLD_BELOW_MIN} min of critical.` });
      }
      continue;
    }

    // Not holding. A queued page (from an earlier hold) is replaced by the real chain.
    if (active && active.status === 'queued') {
      ctx.db.page.id.update({ ...active, status: 'superseded' });
      active = undefined;
    }

    // Timed out without an acknowledgement: mark it missed so the next person is paged.
    if (active && active.status === 'paging' && secondsBetween(active.pagedAt, ctx.timestamp) >= active.timeoutSec) {
      ctx.db.page.id.update({ ...active, status: 'missed' });
      chainRec(ctx, 'page_missed', w.id, [], `${techName(ctx, active.techId)} did not acknowledge the ${incidentLabel(w)} page within ${active.timeoutSec}s.`);
      active = undefined;
    }
    if (active) continue;

    // Chain: on-shift techs ranked, then supervisors as the last resort.
    const chain = [
      ...onShift.map(x => ({ tech: x.tech, why: x.why })),
      ...[...ctx.db.tech.iter()].filter(tc => tc.role === 'supervisor').map(tc => ({ tech: tc, why: 'supervisor, last resort' })),
    ];
    if (!chain.length) continue;
    const pagesNow = [...ctx.db.page.warningId.filter(w.id)];
    let round = pagesNow.reduce((m, p) => Math.max(m, p.round), 0);
    let tried = new Set(pagesNow.filter(p => p.round === round && p.status !== 'superseded' && p.status !== 'queued').map(p => p.techId));
    let next = chain.find(c => !tried.has(c.tech.id));
    if (!next) {
      round += 1; // everyone missed it: start again from the top
      tried = new Set();
      next = chain[0];
    }
    const timeoutSec = ACK_TIMEOUT_SEC[inc.priority] ?? 30;
    const pos = chain.findIndex(c => c.tech.id === next!.tech.id) + 1;
    const after = chain[pos];
    ctx.db.page.insert({ id: 0n, warningId: w.id, techId: next.tech.id, round, status: 'paging', pagedAt: ctx.timestamp, ackAt: undefined, timeoutSec, reason: next.why });
    chainRec(ctx, 'paged', w.id, [], `Night Watch paged ${next.tech.name} for ${incidentLabel(w)} (${inc.priority} priority, ${next.why}); ${timeoutSec}s to acknowledge.`);
    const skipped = best && best.tech.shift !== shift && urgent ? ` Not waiting for ${best.tech.name} (${best.tech.shift} shift, best match): ${eta >= 0 && eta <= HOLD_BELOW_MIN ? `only ${fmtEta(eta)} to critical` : 'priority is critical'}.` : '';
    ctx.db.incident.warningId.update({
      ...inc,
      mode: 'page_now',
      decision: `Paging ${next.tech.name} (${pos} of ${chain.length}): ${next.why}.${skipped} ${after ? `Escalates to ${after.tech.name} if not acknowledged in ${timeoutSec}s.` : 'Last in the chain.'}`,
    });
  }
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
  // A database that predates the team/tenant tables gets them filled in automatically.
  if ([...ctx.db.techProfile.iter()].length < TEAM.length) seedTeam(ctx);

  // ── CDUs first: their health decides how hot the racks in their aisle run.
  const cduHealth = new Map<string, number>(); // aisle -> 0 (dead) .. 1 (healthy)
  for (const c of [...ctx.db.cdu.iter()]) {
    const flowLpm =
      // Real-time pace a person can follow: a pump failure loses ~40 L/min per minute.
      c.fault === 'pump' ? Math.max(8, c.flowLpm - 1.6 - ctx.random() * 0.8)
      : c.fault === 'leak' ? Math.max(30, c.flowLpm - 0.8 - ctx.random() * 0.6)
      : drift(c.flowLpm, 120, ctx, 2, RECOVER);
    const pressureKpa =
      c.fault === 'leak' ? Math.max(40, c.pressureKpa - 2.2 - ctx.random() * 1.2)
      : c.fault === 'pump' ? Math.max(90, c.pressureKpa - 1 - ctx.random() * 0.4)
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
      : f === 'cooling' ? r.temperatureF + 0.28 + ctx.random() * 0.12 // fan failure: ~7°F per minute
      : f === 'power' ? r.temperatureF + 0.06 + ctx.random() * 0.04
      : drift(r.temperatureF, tempTarget, ctx, 0.8, r.temperatureF > tempTarget + 1 ? RECOVER : 0.25);
    const powerKw = down ? 0 : f === 'power' ? r.powerKw + 0.18 + ctx.random() * 0.08 : Math.max(5, drift(r.powerKw || 9, 9, ctx, 0.3, RECOVER));
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

  linkExperiment(ctx);
  updateIncidents(ctx);
  runEscalation(ctx);
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
  // Claiming is the acknowledgement: it stops the escalation chain.
  let acked = false;
  for (const p of [...ctx.db.page.warningId.filter(warningId)]) {
    if (p.status !== 'paging' && p.status !== 'queued') continue;
    if (p.techId === techId) {
      ctx.db.page.id.update({ ...p, status: 'acknowledged', ackAt: ctx.timestamp });
      acked = true;
    } else ctx.db.page.id.update({ ...p, status: 'skipped' });
  }
  const secs = Math.round(secondsBetween(w.createdAt, ctx.timestamp));
  ctx.db.chainRecord.insert({
    id: 0n,
    kind: 'claim',
    refId: warningId,
    techIds: [techId],
    summary: `${who.name} ${acked ? 'acknowledged the page and ' : ''}took ownership of the ${w.rackId} ${w.kind === 'reported' ? 'reported issue' : 'warning'} ${secs}s after the alert.`,
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

// "I can't take this one": the chain moves on to the next person right away.
export const declinePage = spacetimedb.reducer({ warningId: t.u64(), techId: t.u64() }, (ctx, { warningId, techId }) => {
  requireTech(ctx, techId);
  const p = [...ctx.db.page.warningId.filter(warningId)].find(x => x.techId === techId && x.status === 'paging');
  if (!p) throw new SenderError('You are not being paged for this');
  ctx.db.page.id.update({ ...p, status: 'declined' });
  const w = ctx.db.warning.id.find(warningId);
  if (w) chainRec(ctx, 'page_declined', warningId, [techId], `${techName(ctx, techId)} declined the ${incidentLabel(w)} page, so it escalated.`);
});

// Start the side-by-side comparison: CDU-A is the baseline (never paged), CDU-C gets Night Watch.
export const startComparison = spacetimedb.reducer(ctx => {
  const ex = ctx.db.experiment.id.find('main');
  if (ex?.active) throw new SenderError('A comparison is already running');
  for (const id of ['CDU-A', 'CDU-C']) {
    const c = ctx.db.cdu.id.find(id);
    if (c) ctx.db.cdu.id.update({ ...c, fault: 'pump' });
  }
  const row = { id: 'main', active: true, startedAt: ctx.timestamp, baselineCdu: 'CDU-A', pagedCdu: 'CDU-C', baselineWarningId: 0n, pagedWarningId: 0n };
  if (ex) ctx.db.experiment.id.update(row);
  else ctx.db.experiment.insert(row);
});

export const stopComparison = spacetimedb.reducer(ctx => {
  const ex = ctx.db.experiment.id.find('main');
  if (ex) ctx.db.experiment.id.update({ ...ex, active: false });
});

// A supervisor can overrule the automatic priority.
export const overridePriority = spacetimedb.reducer({ warningId: t.u64(), techId: t.u64(), priority: t.string() }, (ctx, { warningId, techId, priority }) => {
  const who = requireTech(ctx, techId);
  if (who.role !== 'supervisor') throw new SenderError('Only a supervisor can override priority');
  if (!LEVELS.includes(priority)) throw new SenderError('Unknown priority');
  const inc = ctx.db.incident.warningId.find(warningId);
  if (!inc) throw new SenderError('Incident not found');
  ctx.db.incident.warningId.update({ ...inc, priority, overriddenBy: techId, bumpReason: `Priority set to ${priority} by ${who.name} (supervisor override).` });
});

// Demo control: which shift is on the floor.
export const setShift = spacetimedb.reducer({ shift: t.string() }, (ctx, { shift }) => {
  if (shift !== 'day' && shift !== 'night') throw new SenderError('Shift must be day or night');
  const f = ctx.db.floor.id.find('main');
  if (f) ctx.db.floor.id.update({ ...f, currentShift: shift });
  else ctx.db.floor.insert({ id: 'main', currentShift: shift });
});

// ─────────────────────────────────────────────────────────────
// Agent actions
// ─────────────────────────────────────────────────────────────

// The agent files its root-cause analysis for a warning.
// The agent fixes a runaway job by itself: move the workload to a rack with spare power.
// Approved list of one action, only for power spikes, only to a healthy rack with headroom.
export const agentMoveJob = spacetimedb.reducer({ warningId: t.u64(), targetRackId: t.string(), reason: t.string() }, (ctx, { warningId, targetRackId, reason }) => {
  const w = ctx.db.warning.id.find(warningId);
  if (!w) throw new SenderError('Warning not found');
  if (w.kind !== 'power') throw new SenderError('The agent can only fix power spikes by itself');
  if (w.status !== 'open') throw new SenderError('Already being handled');
  const src = ctx.db.rack.id.find(w.rackId);
  const dst = ctx.db.rack.id.find(targetRackId);
  if (!src || !dst) throw new SenderError('Rack not found');
  if (dst.id === src.id || dst.status !== 'ok' || dst.powerKw > 11) throw new SenderError(`${targetRackId} doesn't have spare power`);
  if (src.powerKw < 12) throw new SenderError(`${src.id} is only at ${src.powerKw.toFixed(1)} kW; not clearly a runaway job yet`);
  const before = src.powerKw;
  ctx.db.rack.id.update({ ...src, fault: '' });
  ctx.db.rack.id.update({ ...dst, powerKw: dst.powerKw + 1.5 });
  ctx.db.warning.id.update({ ...w, status: 'fixing' });
  const steps = [
    { d: `Found what's driving the spike: a workload on ${src.id} pushing power to ${before.toFixed(1)} kW (normal is about 9).`, r: reason },
    { d: `Moved that workload to ${dst.id}, which has the most spare power (${dst.powerKw.toFixed(1)} kW in use).`, r: 'Approved action: move a job to a healthy rack with headroom. Reversible.' },
    { d: `Confirm ${src.id} power drops back under 12 kW.`, r: '' },
  ];
  steps.forEach((x, i) => ctx.db.task.insert({ id: 0n, warningId, stepNumber: i + 1, description: x.d, executor: 'agent', status: i < 2 ? 'done' : 'pending', result: x.r }));
  chainRec(ctx, 'agent_action', warningId, [], `Nemotron agent moved the runaway job from ${src.id} (${before.toFixed(1)} kW) to ${dst.id}. No tech was paged.`);
});

export const setAnalysis = spacetimedb.reducer(
  { warningId: t.u64(), rootCause: t.string(), evidence: t.string(), runbook: t.string(), confidence: t.u32(), callSenior: t.bool() },
  (ctx, { warningId, rootCause, evidence, runbook, confidence, callSenior }) => {
    if (!ctx.db.warning.id.find(warningId)) throw new SenderError('Warning not found');
    const row = { warningId, rootCause, evidence, runbook, confidence: Math.min(100, confidence), callSenior, createdAt: ctx.timestamp };
    if (ctx.db.analysis.warningId.find(warningId)) ctx.db.analysis.warningId.update(row);
    else ctx.db.analysis.insert(row);
  }
);

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

// The chain service records the transaction plus the hash link it wrote.
export const setChainProof = spacetimedb.reducer(
  { recordId: t.u64(), txSignature: t.string(), chainKey: t.string(), sha256: t.string(), prevSha256: t.string() },
  (ctx, { recordId, txSignature, chainKey, sha256, prevSha256 }) => {
    const rec = ctx.db.chainRecord.id.find(recordId);
    if (!rec) throw new SenderError('Record not found');
    ctx.db.chainRecord.id.update({ ...rec, txSignature });
    const row = { recordId, chainKey, sha256, prevSha256 };
    if (ctx.db.chainLink.recordId.find(recordId)) ctx.db.chainLink.recordId.update(row);
    else ctx.db.chainLink.insert(row);
  }
);

// The agent stores the latest news signal for a tenant.
export const setTenantSignal = spacetimedb.reducer(
  { tenantId: t.u64(), company: t.string(), headline: t.string(), url: t.string(), source: t.string(), publishedAt: t.string(), score: t.u32(), note: t.string() },
  (ctx, args) => {
    if (!ctx.db.tenant.id.find(args.tenantId)) throw new SenderError('Tenant not found');
    const row = { ...args, score: Math.min(2, args.score), checkedAt: ctx.timestamp };
    if (ctx.db.tenantSignal.tenantId.find(args.tenantId)) ctx.db.tenantSignal.tenantId.update(row);
    else ctx.db.tenantSignal.insert(row);
  }
);

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
  for (const x of [...ctx.db.incident.iter()]) ctx.db.incident.warningId.delete(x.warningId);
  for (const x of [...ctx.db.handoff.iter()]) ctx.db.handoff.id.delete(x.id);
  for (const x of [...ctx.db.chainRecord.iter()]) ctx.db.chainRecord.id.delete(x.id);
  for (const x of [...ctx.db.page.iter()]) ctx.db.page.id.delete(x.id);
  for (const x of [...ctx.db.chainLink.iter()]) ctx.db.chainLink.recordId.delete(x.recordId);
  const exr = ctx.db.experiment.id.find('main');
  if (exr) ctx.db.experiment.id.update({ ...exr, active: false, baselineWarningId: 0n, pagedWarningId: 0n });
  for (const x of [...ctx.db.incident.iter()]) ctx.db.incident.warningId.delete(x.warningId);
  for (const x of [...ctx.db.analysis.iter()]) ctx.db.analysis.warningId.delete(x.warningId);
  const fl = ctx.db.floor.id.find('main');
  if (fl) ctx.db.floor.id.update({ ...fl, currentShift: 'night' });
  for (const x of [...ctx.db.rack.iter()]) ctx.db.rack.id.delete(x.id);
  for (const x of [...ctx.db.cduReading.iter()]) ctx.db.cduReading.id.delete(x.id);
  for (const x of [...ctx.db.cdu.iter()]) ctx.db.cdu.id.delete(x.id);
  // Keep techs (and their wallets); only add them if missing.
  if ([...ctx.db.tech.iter()].length === 0) seed(ctx);
  else {
    seedTeam(ctx);
    seedRacks(ctx);
  }
  startTimer(ctx);
});
