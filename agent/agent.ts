// Night Watch agent, powered by NVIDIA Nemotron.
// 1. Early warning: watches rack temperature trends and raises a warning before the hard limit.
// 2. Fix plan: writes step-by-step plans for every warning and runs the steps it can do itself.
// 3. Handoff brief: rewrites shift handoffs into a clear, prioritized brief.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DbConnection } from '../src/module_bindings/index.ts';

// ─── config ───────────────────────────────────────────────
for (const f of ['./.env', '../.env.local']) {
  try {
    process.loadEnvFile(new URL(f, import.meta.url));
  } catch {
    /* optional */
  }
}
const KEY = process.env.NVIDIA_API_KEY ?? process.env.LLM_API_KEY ?? '';
if (!KEY || KEY.includes('paste-your-key')) {
  console.error('❌ Put your key in agent/.env as NVIDIA_API_KEY=...');
  process.exit(1);
}
// nvapi-... keys go to NVIDIA directly; sk-or-... keys go through OpenRouter.
const viaOpenRouter = KEY.startsWith('sk-or-');
const BASE_URL = process.env.LLM_BASE_URL ?? (viaOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://integrate.api.nvidia.com/v1');
const MODEL = process.env.LLM_MODEL ?? (viaOpenRouter ? 'nvidia/nemotron-3-nano-30b-a3b:free' : 'nvidia/nemotron-3.5-lightning-30b-a3b');
const HOST = process.env.SPACETIMEDB_HOST ?? 'https://maincloud.spacetimedb.com';
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? '';
const TOKEN_FILE = new URL('./.spacetime-token', import.meta.url);
const SCAN_EVERY_MS = 6_000;

// ─── Nemotron ─────────────────────────────────────────────
let thinkingOffSupported = !viaOpenRouter;
async function askNemotron(system: string, user: string, label: string): Promise<string> {
  const started = Date.now();
  log('💭', `Asking Nemotron: ${label}…`);
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(45_000), // never hang forever
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 2000,
      // Turn off Nemotron's "thinking out loud" so it answers directly (NVIDIA endpoints).
      ...(thinkingOffSupported ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      messages: [
        // "/no_think" turns off long hidden reasoning on Nemotron models, so replies come back fast.
        { role: 'system', content: `/no_think\n${system}` },
        { role: 'user', content: user },
      ],
    }),
  });
  log('💬', `Nemotron answered in ${((Date.now() - started) / 1000).toFixed(1)}s (${label})`);
  if (res.status === 400 && thinkingOffSupported) {
    thinkingOffSupported = false; // this endpoint doesn't know the option; retry without it
    return askNemotron(system, user, label);
  }
  if (!res.ok) throw new Error(`Nemotron ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    choices: { message: { content: string | null; reasoning_content?: string | null } }[];
  };
  const msg = data.choices?.[0]?.message;
  // Some Nemotron versions put the answer in reasoning_content when content is empty.
  const text = (msg?.content || msg?.reasoning_content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return text;
}

// Pull a JSON object out of a reply. Models sometimes wrap it in text, code fences or reasoning,
// so try every "{" and keep the first one that parses as balanced JSON.
function parseJson<T>(text: string, key: string): T | null {
  const clean = text.replace(/```(?:json)?/g, '');
  // If the model "thinks out loud" it may echo the example first, so keep the LAST match.
  let found: T | null = null;
  for (let start = clean.indexOf('{'); start >= 0; start = clean.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < clean.length; i++) {
      const c = clean[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const obj = JSON.parse(clean.slice(start, i + 1));
          if (obj && typeof obj === 'object' && key in obj) found = obj as T;
        } catch {
          /* not JSON, keep looking */
        }
        break;
      }
    }
  }
  if (found) return found;
  log('🤔', `Couldn't read JSON from Nemotron. It said: ${text.slice(0, 400).replace(/\s+/g, ' ')}`);
  return null;
}

const log = (icon: string, msg: string) => console.log(`${new Date().toLocaleTimeString()} ${icon} ${msg}`);

// Never let a rejected Spacetime call crash the agent; log it instead.
function safe(name: string, p: unknown) {
  if (p && typeof (p as Promise<unknown>).catch === 'function') {
    (p as Promise<unknown>).catch(e => {
      const msg = (e as Error).message;
      log('⚠️', `${name} failed: ${msg}${msg.includes('no such reducer') ? ' (backend not republished? run: spacetime publish -y)' : ''}`);
    });
  }
}

// ─── helpers over live Spacetime data ─────────────────────
type Conn = DbConnection;
type Reading = { temperatureF: number; powerKw: number; humidityPct: number; diskErrors: number; packetLossPct: number; pduALoadPct: number; pduBLoadPct: number };

// Every sensor the agent watches, with normal values, limits and how fast a "real" trend moves per reading.
const SENSORS = {
  cooling: { name: 'temperature', unit: '°F', normal: '~72', warn: 82, crit: 90, trend: 0.35, read: (r: Reading) => r.temperatureF },
  power: { name: 'power draw', unit: 'kW', normal: '~9', warn: 14, crit: 17, trend: 0.2, read: (r: Reading) => r.powerKw },
  disk: { name: 'disk errors', unit: 'errors', normal: '0', warn: 10, crit: 30, trend: 0.8, read: (r: Reading) => r.diskErrors },
  network: { name: 'packet loss', unit: '%', normal: '<0.5', warn: 3, crit: 8, trend: 0.2, read: (r: Reading) => r.packetLossPct },
  humidity: { name: 'humidity', unit: '% RH', normal: '~46', warn: 60, crit: 70, trend: 0.5, read: (r: Reading) => r.humidityPct },
  pdu: { name: 'PDU load (worst feed)', unit: '%', normal: '~38 per feed with both A and B up', warn: 80, crit: 95, trend: 2, read: (r: Reading) => Math.max(r.pduALoadPct, r.pduBLoadPct) },
} as const;
type Kind = keyof typeof SENSORS;
const KIND_LIST = Object.keys(SENSORS) as Kind[];

const activeWarning = (conn: Conn, rackId: string, kind: string) =>
  [...conn.db.warning.iter()].find(w => w.rackId === rackId && w.kind === kind && w.status !== 'resolved');

function history(conn: Conn, rackId: string, kind: Kind, n = 12) {
  return [...conn.db.sensorReading.iter()]
    .filter(r => r.rackId === rackId)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(-n)
    .map(r => Math.round(SENSORS[kind].read(r) * 10) / 10);
}
const slope = (xs: number[]) => (xs.length < 2 ? 0 : (xs[xs.length - 1] - xs[0]) / (xs.length - 1));

function cduSeries(conn: Conn, cduId: string, n = 12) {
  return [...conn.db.cduReading.iter()].filter(x => x.cduId === cduId).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(-n);
}

// Tool the agent can run on its own: read live telemetry for a rack or a CDU.
function telemetryTool(conn: Conn, id: string, focus?: string) {
  const c = conn.db.cdu.id.find(id);
  if (c) {
    const h = cduSeries(conn, id, 6);
    const fl = slope(h.map(x => x.flowLpm));
    const pr = slope(h.map(x => x.pressureKpa));
    const racks = [...conn.db.rack.iter()].filter(r => r.aisle === c.aisle).map(r => `${r.id} ${r.temperatureF.toFixed(1)}°F`);
    return `Telemetry ${id}: coolant flow ${c.flowLpm.toFixed(0)} L/min (${fl.toFixed(1)}/reading), pressure ${c.pressureKpa.toFixed(0)} kPa (${pr.toFixed(1)}/reading), coolant supply ${c.supplyTempC.toFixed(1)}°C. Cools racks: ${racks.join(', ')}.`;
  }
  const r = conn.db.rack.id.find(id);
  if (!r) return 'Not found.';
  const parts = KIND_LIST.filter(k => k !== 'pdu').map(k => {
    const s = SENSORS[k];
    const tr = slope(history(conn, id, k, 6));
    return `${s.name} ${s.read(r).toFixed(1)}${s.unit === '°F' ? '°F' : ' ' + s.unit}${Math.abs(tr) > s.trend / 2 ? ` (${tr > 0 ? '+' : ''}${tr.toFixed(2)}/reading)` : ''}`;
  });
  const pdu = `PDU A ${r.pduAOnline ? r.pduALoadPct.toFixed(0) + '%' : 'OFFLINE'}, PDU B ${r.pduBOnline ? r.pduBLoadPct.toFixed(0) + '%' : 'OFFLINE'}`;
  const aisleCdu = conn.db.cdu.id.find(`CDU-${r.aisle}`);
  const cool = aisleCdu ? `, aisle CDU-${r.aisle} flow ${aisleCdu.flowLpm.toFixed(0)} L/min` : '';
  // (The simulator's hidden fault flag is never shown to the agent — it has to read the numbers like a real one.)
  return `Telemetry ${id}${focus ? ` [${focus}]` : ''}: ${parts.join(', ')}, ${pdu}${cool}.`;
}

// ─── 1. early warning ─────────────────────────────────────
let scanning = false;
const quietUntil = new Map<string, number>(); // don't re-ask about a sensor Nemotron just cleared
async function scan(conn: Conn) {
  if (scanning) return;
  scanning = true;
  try {
    // Only bother Nemotron about sensors that are drifting toward a limit and not already handled.
    const suspects: { rackId: string; kind: Kind; series: number[]; extra?: string }[] = [];
    for (const r of conn.db.rack.iter()) {
      for (const k of KIND_LIST) {
        if (activeWarning(conn, r.id, k)) continue;
        if ((quietUntil.get(`${r.id}/${k}`) ?? 0) > Date.now()) continue;
        const s = SENSORS[k];
        const series = history(conn, r.id, k);
        if (series.length < 4) continue;
        const now = series[series.length - 1];
        if (slope(series.slice(-5)) > s.trend || now > s.warn * 0.92) suspects.push({ rackId: r.id, kind: k, series });
      }
    }
    // CDUs: watch for coolant flow or pressure falling.
    for (const c of conn.db.cdu.iter()) {
      if (activeWarning(conn, c.id, 'cdu')) continue;
      if ((quietUntil.get(`${c.id}/cdu`) ?? 0) > Date.now()) continue;
      const h = cduSeries(conn, c.id);
      if (h.length < 4) continue;
      const flow = h.map(x => Math.round(x.flowLpm));
      const pres = h.map(x => Math.round(x.pressureKpa));
      if (slope(flow.slice(-5)) < -2 || slope(pres.slice(-5)) < -2.5 || c.flowLpm < 108 || c.pressureKpa < 195) {
        suspects.push({ rackId: c.id, kind: 'cdu' as Kind, series: flow, extra: `pressure kPa: ${pres.join(', ')}; racks cooled: ${[...conn.db.rack.iter()].filter(r => r.aisle === c.aisle).map(r => r.id).join(', ')}` });
      }
    }
    if (!suspects.length) return;

    const limits =
      KIND_LIST.map(k => `${k} (${SENSORS[k].name}): normal ${SENSORS[k].normal} ${SENSORS[k].unit}, warning ${SENSORS[k].warn}, critical ${SENSORS[k].crit}`).join('\n') +
      '\ncdu (coolant distribution unit, liquid cooling for a whole aisle of GPU racks): normal flow ~120 L/min and pressure ~210 kPa; warning below 90 L/min or 160 kPa; critical below 50 L/min or 110 kPa. A failing CDU overheats every rack in its aisle within minutes.';
    const reply = await askNemotron(
      `You are a data center reliability agent. Readings come every 3 seconds. Decide which sensors need a technician NOW, before they cross the warning limit. Ignore normal noise. Reply with JSON only.\nLimits:\n${limits}`,
      `Sensors trending (oldest to newest):\n${suspects.map(x => `${x.rackId} ${x.kind === ('cdu' as Kind) ? 'cdu flow L/min' : x.kind}: ${x.series.join(', ')}${x.extra ? ` (${x.extra})` : ''}`).join('\n')}\n\nReturn: {"alerts":[{"rackId":"R-12","kind":"cooling|power|disk|network|humidity|pdu|cdu","severity":"low|medium|critical","minutesToCritical":3,"reason":"short sentence a tech can act on"}]}. Use an empty list if nothing needs action.`,
      `trend check on ${suspects.map(x => `${x.rackId}/${x.kind}`).join(', ')}`
    );
    const parsed = parseJson<{ alerts?: { rackId: string; kind?: string; severity: string; minutesToCritical?: number; reason: string }[] }>(reply, 'alerts');
    const alerts = parsed?.alerts ?? [];
    if (parsed && !alerts.length) {
      log('✅', 'Nemotron: nothing needs action yet');
      for (const x of suspects) quietUntil.set(`${x.rackId}/${x.kind}`, Date.now() + 20_000);
    }
    for (const a of alerts) {
      // Nemotron sometimes writes "R-11 power" or "R-11/power" — normalize before matching.
      const rid = (`${a.rackId ?? ''}`.match(/R-\d+|CDU-[A-Z]/i)?.[0] ?? '').toUpperCase();
      const k = `${a.kind ?? ''} ${a.rackId ?? ''}`.toLowerCase();
      const kindGuess = rid.startsWith('CDU') ? ('cdu' as Kind) : KIND_LIST.find(kk => k.includes(kk) || k.includes(SENSORS[kk].name.split(' ')[0].toLowerCase()));
      const match =
        suspects.find(x => x.rackId === rid && x.kind === kindGuess) ??
        suspects.find(x => x.rackId === rid) ??
        (suspects.length === 1 ? suspects[0] : undefined);
      if (!match) {
        log('🤔', `Nemotron flagged something I couldn't match: ${JSON.stringify(a).slice(0, 200)}`);
        continue;
      }
      const eta = a.minutesToCritical !== undefined ? ` About ${a.minutesToCritical} min to critical.` : '';
      safe('raiseWarning', conn.reducers.raiseWarning({ rackId: match.rackId, kind: match.kind, severity: a.severity, message: `${a.reason}${eta}` }));
      log('🧠', `Early warning on ${match.rackId} ${match.kind} (${a.severity}): ${a.reason}`);
    }
  } catch (e) {
    log('⚠️', `Scan failed: ${(e as Error).message}`);
  } finally {
    scanning = false;
  }
}

// Pull steps out of almost-JSON, e.g. {"description","text","executor":"agent"}.
function salvageSteps(text: string) {
  const out: { description: string; executor: string }[] = [];
  const re = /"description"\s*[:,]\s*"((?:[^"\\]|\\.)+)"\s*,\s*"executor"\s*[:,]\s*"(\w+)"/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ description: m[1].replace(/\\"/g, '"'), executor: m[2] });
  if (out.length) log('🩹', `Fixed Nemotron's broken JSON (${out.length} steps recovered)`);
  return out;
}

// ─── 2. fix plans ─────────────────────────────────────────
const planning = new Set<bigint>();
async function plan(conn: Conn, warningId: bigint) {
  const w = conn.db.warning.id.find(warningId);
  if (!w || w.status === 'resolved' || planning.has(warningId)) return;
  if ([...conn.db.task.iter()].some(t => t.warningId === warningId)) return;
  planning.add(warningId);
  try {
    const reply = await askNemotron(
      'You are a data center operations agent. Write a short fix plan. You (the agent) can only read telemetry and check monitoring data. Anything physical or hands-on (inspecting, replacing, cleaning, reseating, mopping, swapping parts) is a "tech" step, and every plan must include at least one "tech" step. Look for root causes: if a rack is hot and its aisle CDU flow is low, the CDU is the real problem; if a rack shows a PDU OFFLINE, it has no backup power and any extra load can trip it. Put agent steps before technician steps. Reply with JSON only.',
      `${w.kind === 'reported' ? 'Issue a technician reported (sensors cannot see it)' : `Sensor warning (${w.kind})`} on ${w.rackId}, severity ${w.severity}: ${w.message}\n${telemetryTool(conn, w.rackId, w.kind)}\n\nReturn: {"steps":[{"description":"one sentence","executor":"agent|tech"}]} with 3 to 5 steps.`,
      `fix plan for ${w.rackId}`
    );
    let steps = parseJson<{ steps?: { description: string; executor: string }[] }>(reply, 'steps')?.steps ?? [];
    if (!steps.length) steps = salvageSteps(reply); // the JSON was slightly broken; pull the steps out anyway
    steps = steps.filter(x => x.description && !/^one sentence$/i.test(x.description.trim()));
    // Every issue needs a human to fix the physical cause; add one if Nemotron forgot.
    if (steps.length && !steps.some(x => x.executor === 'tech')) {
      const at = Math.max(1, steps.length - 1);
      steps.splice(at, 0, { description: `Go to ${w.rackId} and fix the physical cause found above.`, executor: 'tech' });
    }
    steps.slice(0, 6).forEach((s, i) =>
      safe('addTask', conn.reducers.addTask({
        warningId,
        stepNumber: i + 1,
        description: s.description,
        executor: s.executor === 'agent' ? 'agent' : 'tech',
      }))
    );
    log('📋', `Plan for ${w.rackId} ${w.kind}: ${steps.length} steps`);
  } catch (e) {
    log('⚠️', `Planning failed for ${w.rackId}: ${(e as Error).message}`);
  } finally {
    planning.delete(warningId);
  }
}

// The agent completes its own steps with the telemetry tool.
// A step only runs once every step before it is done, so "confirm the fix" waits for the tech.
const ranSteps = new Set<bigint>();
function runAgentSteps(conn: Conn) {
  const all = [...conn.db.task.iter()];
  for (const t of all) {
    if (t.executor !== 'agent' || t.status !== 'pending' || ranSteps.has(t.id)) continue;
    const w = conn.db.warning.id.find(t.warningId);
    if (!w) continue;
    const blocked = all.some(o => o.warningId === t.warningId && o.stepNumber < t.stepNumber && o.status !== 'done');
    if (blocked) continue;
    // Verification steps after a fix wait until the sensor data has confirmed it.
    const afterTech = all.some(o => o.warningId === t.warningId && o.executor === 'tech' && o.stepNumber < t.stepNumber);
    if (afterTech && w.status !== 'resolved') continue;
    ranSteps.add(t.id);
    safe('updateTask', conn.reducers.updateTask({ taskId: t.id, status: 'done', result: telemetryTool(conn, w.rackId, w.kind) }));
    log('🔧', `Agent ran step ${t.stepNumber} on ${w.rackId}`);
  }
}

// ─── 3. handoff briefs ────────────────────────────────────
const briefing = new Set<bigint>();
async function brief(conn: Conn, handoffId: bigint) {
  const h = conn.db.handoff.id.find(handoffId);
  if (!h || h.status !== 'pending' || h.fromSignedAt || h.toSignedAt || briefing.has(handoffId)) return;
  if (h.brief.startsWith('🧠')) return; // already written by the agent
  briefing.add(handoffId);
  try {
    const name = (id: bigint) => conn.db.tech.id.find(id)?.name ?? 'unknown';
    const open = [...conn.db.warning.iter()].filter(w => w.status !== 'resolved');
    const facts = open.length
      ? open
          .map(w => {
            const steps = [...conn.db.task.iter()].filter(t => t.warningId === w.id);
            const left = steps.filter(t => t.status !== 'done').map(t => t.description);
            return `- ${w.rackId} ${w.kind} [${w.severity}, ${w.status}, owner ${w.claimedBy !== undefined ? name(w.claimedBy) : 'nobody'}]: ${w.message} | ${telemetryTool(conn, w.rackId)} | Remaining steps: ${left.join('; ') || 'none'}`;
          })
          .join('\n')
      : 'No open warnings.';
    const reply = await askNemotron(
      'You write shift handoff briefs for data center technicians. Be concrete and short: what is open, what is getting worse, what to check first. Plain text, max 6 bullet lines, no preamble.',
      `Outgoing: ${name(h.fromTechId)}. Incoming: ${name(h.toTechId)}.\nOutgoing tech's own notes: ${h.brief}\nOpen items on the floor:\n${facts}`,
      'handoff brief'
    );
    if (reply) {
      safe('updateHandoffBrief', conn.reducers.updateHandoffBrief({ handoffId, brief: `🧠 Nemotron brief\n${reply}` }));
      log('🤝', `Wrote handoff brief ${name(h.fromTechId)} → ${name(h.toTechId)}`);
    }
  } catch (e) {
    log('⚠️', `Brief failed: ${(e as Error).message}`);
  } finally {
    briefing.delete(handoffId);
  }
}

// ─── wire it up ───────────────────────────────────────────
if (!DB_NAME) throw new Error('SPACETIMEDB_DB_NAME missing (looked in ../.env.local)');
log('🚀', `Night Watch agent using ${MODEL} via ${viaOpenRouter ? 'OpenRouter' : 'NVIDIA'}`);

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8') : undefined)
  .onConnect((conn, _id, token) => {
    writeFileSync(TOKEN_FILE, token);
    log('🔌', `Connected to Spacetime database ${DB_NAME}`);
    conn.db.warning.onInsert((_ctx, w) => void plan(conn, w.id));
    conn.db.task.onInsert(() => runAgentSteps(conn));
    conn.db.task.onUpdate(() => runAgentSteps(conn));
    conn.db.warning.onUpdate(() => runAgentSteps(conn));
    conn.db.handoff.onInsert((_ctx, h) => void brief(conn, h.id));
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        log('👀', 'Watching racks, warnings and handoffs…');
        for (const w of conn.db.warning.iter()) void plan(conn, w.id);
        for (const h of conn.db.handoff.iter()) void brief(conn, h.id);
        runAgentSteps(conn);
        setInterval(() => void scan(conn), SCAN_EVERY_MS);
      })
      .subscribe([
        'SELECT * FROM rack',
        'SELECT * FROM sensor_reading',
        'SELECT * FROM warning',
        'SELECT * FROM task',
        'SELECT * FROM handoff',
        'SELECT * FROM tech',
        'SELECT * FROM cdu',
        'SELECT * FROM cdu_reading',
      ]);
  })
  .onConnectError((_ctx, err) => console.error('Spacetime connection error:', err))
  .onDisconnect(() => log('🔌', 'Disconnected from Spacetime'))
  .build();
