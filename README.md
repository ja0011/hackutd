# Night Watch

A decentralized oracle network for data center operations, built for HackUTD 2026 (NMC² "Keep the World Running", with the Spacetime, Nvidia Nemotron and Solana tracks).

When a data center problem happens, the team has to decide who to call, what to fix first, and which customers are affected, and the record of what happened needs to be trustworthy. Night Watch helps them act on the right incident first. It brings in live news on each customer so the most at-risk ones come first, and it logs every page, assignment and fix on Solana so the record can't be changed. This improves time to owned and customer satisfaction.

## Two goals

**Customer satisfaction: the right incident first**
- Live Google News headlines are pulled for each customer, and Nvidia Nemotron scores how upset that customer is likely to be. A customer already in the news gets a priority bump, so a small problem is treated as urgent.
- Every incident shows time to critical, cost per 10 minutes, SLA risk and which customers are exposed.
- The best-matched tech is paged by skill and past fixes. If they don't acknowledge in time, it escalates to the next person. When an incident can safely wait, it holds for the best person's next shift.
- For power spikes, the agent fixes the problem itself and pages nobody.

**Security: a record that can't be changed**
- Every page, claim, handoff and fix is written to Solana devnet (Memo program) as a sha256 fingerprint, signed by the people involved.
- Each record includes the fingerprint of the one before it. The **Verify** button on the Audit trail tab recomputes the chain and flags any edit.

Every diagnosis comes with a root cause, a runbook citation and a confidence score. A citation that doesn't match a real runbook step caps the confidence.

## How it works

| Piece | What it does |
|---|---|
| `spacetimedb/` | SpacetimeDB module: racks, cooling units, warnings, incidents, pages, escalation and a scheduled simulation tick every 3 seconds |
| `agent/` | Nemotron agent: why-analysis, fix plans, self-fix for power spikes, news scoring |
| `chain/` | Solana service: writes hash-linked, co-signed records to devnet |
| `src/` | React and TypeScript dashboard, live from SpacetimeDB |

## Demo notes

- Customers, downtime rates and the technician roster are **sample data**. The news headlines are real, but about stand-in companies, not actual customers.
- The Solana records are on **devnet**.
- Problems can be triggered from the floor map. Break a rack's power feed (`pdu`), spike a rack's power, or fail a cooling unit's pump.

## Run it

1. Install the [SpacetimeDB CLI](https://spacetimedb.com/install), and Node.js 22 or later.
2. Install dependencies in the root, `agent/` and `chain/` with `npm install`.
3. Publish the module: `cd spacetimedb && spacetime publish -y`.
4. Put your key in `agent/.env` as `NVIDIA_API_KEY=...`, and set `SPACETIMEDB_DB_NAME` in `.env.local`.
5. Start the agent: `cd agent && npm start`.
6. Start the Solana service (optional, for signed records): `cd chain && npm start`.
7. Start the dashboard: `npm run dev`, then open http://localhost:5173.

## What's next

Real telemetry and customer data in place of the sample tenants, phone pings with bonus payouts for fast responses, and moving the audit trail from devnet to mainnet.
