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
const activeWarning = (conn: Conn, rackId: string) =>
  [...conn.db.warning.iter()].find(w => w.rackId === rackId && w.status !== 'resolved');

function history(conn: Conn, rackId: string, n = 12) {
  return [...conn.db.sensorReading.iter()]
    .filter(r => r.rackId === rackId)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(-n)
    .map(r => Math.round(r.temperatureF * 10) / 10);
}
const slope = (xs: number[]) => (xs.length < 2 ? 0 : (xs[xs.length - 1] - xs[0]) / (xs.length - 1));

// Tool the agent can run on its own: read live telemetry for a rack.
function telemetryTool(conn: Conn, rackId: string) {
  const r = conn.db.rack.id.find(rackId);
  if (!r) return 'Rack not found.';
  const h = history(conn, rackId, 8);
  return `Telemetry ${rackId}: ${r.temperatureF.toFixed(1)}°F, ${r.powerKw.toFixed(1)} kW, trend ${slope(h) >= 0 ? '+' : ''}${slope(h).toFixed(2)}°F per reading, cooling ${r.failing ? 'FAULT detected' : 'nominal'}.`;
}

// ─── 1. early warning ─────────────────────────────────────
let scanning = false;
async function scan(conn: Conn) {
  if (scanning) return;
  scanning = true;
  try {
    // Only bother Nemotron about racks that are drifting up and not already handled.
    const suspects = [...conn.db.rack.iter()]
      .filter(r => !activeWarning(conn, r.id))
      .map(r => ({ id: r.id, now: r.temperatureF, history: history(conn, r.id) }))
      .filter(r => r.history.length >= 4 && (slope(r.history.slice(-5)) > 0.35 || r.now > 77));
    if (!suspects.length) return;

    const reply = await askNemotron(
      'You are a data center reliability agent. Normal rack temp is ~72°F, warning at 82°F, critical at 90°F. Readings are every 3 seconds. Decide which racks need a technician NOW, before they cross the limit. Ignore normal noise. Reply with JSON only.',
      `Recent readings (oldest to newest):\n${suspects.map(s => `${s.id}: ${s.history.join(', ')}`).join('\n')}\n\nReturn: {"alerts":[{"rackId":"R-12","severity":"low|medium|critical","minutesToCritical":3,"reason":"one short sentence a tech can act on"}]}. Use an empty list if nothing needs action.`,
      `trend check on ${suspects.map(x => x.id).join(', ')}`
    );
    const parsed = parseJson<{ alerts?: { rackId: string; severity: string; minutesToCritical?: number; reason: string }[] }>(reply, 'alerts');
    if (parsed && !(parsed.alerts ?? []).length) log('✅', 'Nemotron: nothing needs action yet');
    for (const a of parsed?.alerts ?? []) {
      if (!suspects.some(s => s.id === a.rackId)) continue;
      const eta = a.minutesToCritical !== undefined ? ` About ${a.minutesToCritical} min to critical.` : '';
      safe('raiseWarning', conn.reducers.raiseWarning({ rackId: a.rackId, severity: a.severity, message: `${a.reason}${eta}` }));
      log('🧠', `Early warning on ${a.rackId} (${a.severity}): ${a.reason}`);
    }
  } catch (e) {
    log('⚠️', `Scan failed: ${(e as Error).message}`);
  } finally {
    scanning = false;
  }
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
      'You are a data center operations agent. Write a short fix plan. You (the agent) can only read telemetry and notify people; anything physical is for a technician. Put agent steps before technician steps. Reply with JSON only.',
      `Warning on ${w.rackId} (${w.severity}): ${w.message}\n${telemetryTool(conn, w.rackId)}\n\nReturn: {"steps":[{"description":"one sentence","executor":"agent|tech"}]} with 3 to 5 steps.`,
      `fix plan for ${w.rackId}`
    );
    const steps = (parseJson<{ steps?: { description: string; executor: string }[] }>(reply, 'steps')?.steps ?? []).filter(
      x => x.description && !/^one sentence$/i.test(x.description.trim())
    );
    steps.slice(0, 6).forEach((s, i) =>
      safe('addTask', conn.reducers.addTask({
        warningId,
        stepNumber: i + 1,
        description: s.description,
        executor: s.executor === 'agent' ? 'agent' : 'tech',
      }))
    );
    log('📋', `Plan for ${w.rackId}: ${steps.length} steps`);
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
    safe('updateTask', conn.reducers.updateTask({ taskId: t.id, status: 'done', result: telemetryTool(conn, w.rackId) }));
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
            return `- ${w.rackId} [${w.severity}, ${w.status}, owner ${w.claimedBy !== undefined ? name(w.claimedBy) : 'nobody'}]: ${w.message} | ${telemetryTool(conn, w.rackId)} | Remaining steps: ${left.join('; ') || 'none'}`;
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
      ]);
  })
  .onConnectError((_ctx, err) => console.error('Spacetime connection error:', err))
  .onDisconnect(() => log('🔌', 'Disconnected from Spacetime'))
  .build();
