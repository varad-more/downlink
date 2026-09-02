/*
 * Phase 3 gate.
 *
 * Sustains a stated event rate into the ingest port for a stated duration
 * while WebSocket clients consume the output, then asserts that nothing in
 * the server grew without bound.
 *
 * One client is deliberately slow (its socket is paused) because that is the
 * only way to prove the backpressure path: a server that queues politely for
 * a healthy client tells you nothing about what it does for a sick one.
 *
 *   node dist/loadtest.js --minutes 10 --rate 500 --clients 3
 */
import { connect } from "node:net";
import WebSocket from "ws";

const arg = (n: string, d: number) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const MINUTES = arg("minutes", 10);
const RATE = arg("rate", 500);
const CLIENTS = arg("clients", 3);
const HOST = process.env.STREAM_HOST ?? "stream";
const INGEST = arg("ingest-port", 9000);
const WS_PORT = arg("ws-port", 9001);
const STATS = arg("stats-port", 9002);

const DESTS = [
  "8.8.8.8", "151.101.1.140", "13.107.42.14", "104.244.42.1", "93.184.216.34",
  "185.199.108.153", "212.58.244.22", "203.0.113.7", "198.51.100.9",
  "200.160.2.3", "41.79.72.1", "202.12.27.33", "91.198.174.192", "5.45.58.1",
  "196.216.2.1", "103.21.244.1", "45.33.32.156", "23.235.33.229",
  "192.0.2.55", "1.1.1.1",
];
const BASE_RTT = [22, 18, 38, 62, 16, 145, 152, 135, 235, 168, 265, 178, 142,
                  195, 288, 240, 34, 55, 300, 12];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rx {
  ws: WebSocket;
  frames: number;
  bytes: number;
  slow: boolean;
  invalid: number;
  maxVolumeKb: number;
}

async function main() {
  const sock = connect(INGEST, HOST);
  await new Promise<void>((res, rej) => {
    sock.once("connect", () => res());
    sock.once("error", rej);
  });
  sock.setNoDelay(true);

  const rx: Rx[] = [];
  for (let i = 0; i < CLIENTS; i++) {
    const ws = new WebSocket(`ws://${HOST}:${WS_PORT}`);
    const r: Rx = {
      ws, frames: 0, bytes: 0, slow: i === 0, invalid: 0, maxVolumeKb: 0,
    };
    ws.on("message", (d: Buffer) => {
      r.frames++;
      r.bytes += d.length;
      try {
        const frame = JSON.parse(d.toString()) as any;
        if (!Array.isArray(frame.entities) || frame.unmeasured < 0 || frame.unmeasured > 1)
          r.invalid++;
        for (const entity of frame.entities ?? []) {
          if (!Array.isArray(entity.path) || typeof entity.method !== "string") r.invalid++;
          r.maxVolumeKb = Math.max(r.maxVolumeKb, entity.bytesKb ?? 0);
        }
      } catch { r.invalid++; }
    });
    ws.on("error", () => {});
    await new Promise<void>((res) => ws.once("open", () => res()));
    // Client 0 stops reading. ws.pause() pauses the underlying socket, so
    // the server's bufferedAmount climbs exactly as it would for a kiosk on
    // a wedged wifi link.
    if (r.slow) ws.pause();
    rx.push(r);
  }

  const initial = await (await fetch(`http://${HOST}:${STATS}/stats`)).json() as any;

  const t0 = Date.now();
  const endAt = t0 + MINUTES * 60_000;
  const BATCH_MS = 20;
  let sent = 0, lines = 0, n = 0, backpressure = 0;
  const samples: { t: number; heap: number; rss: number; entities: number }[] = [];

  const statsTimer = setInterval(async () => {
    try {
      const s = await (await fetch(`http://${HOST}:${STATS}/stats`)).json() as any;
      samples.push({ t: Date.now(), heap: s.heapUsedMb, rss: s.rssMb, entities: s.entities });
      console.log(
        `t+${Math.round(process.uptime())}s sent=${sent} heap=${s.heapUsedMb}MB ` +
        `rss=${s.rssMb}MB entities=${s.entities} cache=${s.resolveCache} ` +
        `frames=${s.framesOut} clients=${JSON.stringify(s.clients)}`);
    } catch (e) { console.log("stats unreachable:", String(e)); }
  }, 15_000);

  while (Date.now() < endAt) {
    // Rate is driven off the wall clock, not off a fixed count per tick.
    // setTimeout(20) reliably sleeps longer than 20 ms, and a fixed batch
    // size silently undershoots the rate the gate claims to be testing.
    const due = Math.floor(((Date.now() - t0) / 1000) * RATE) - sent;
    let chunk = "";
    for (let i = 0; i < due; i++, n++) {
      const k = n % DESTS.length;
      const jitter = ((n * 37) % 11) - 5;          // deterministic, no RNG
      const rttUs = Math.round((BASE_RTT[k]! + jitter) * 1000);
      chunk += `rtt dst=${DESTS[k]} rtt_us=${rttUs}\n`;
      if (n % 50 === 0) chunk += `vol dst=${DESTS[k]} bytes=${1500 + (n % 9000)}\n`;
      if (n % 5000 === 0) {
        chunk += `stat pkts=${n} ipv4_tcp=${n} ipv6_skipped=0 ipv6_bytes=0 quic_pkts=${n / 10} ` +
                 `quic_bytes=${n * 120} rtt_emitted=${n} rate_limited=0 ` +
                 `rb_dropped=0 syn_tracked=${n}\n`;
      }
      sent++;
    }
    lines += chunk.length ? chunk.split("\n").length - 1 : 0;
    if (chunk && !sock.write(chunk)) {
      backpressure++;
      await new Promise<void>((r) => sock.once("drain", () => r()));
    }
    await sleep(BATCH_MS);
  }

  clearInterval(statsTimer);
  await sleep(2000);
  const final = await (await fetch(`http://${HOST}:${STATS}/stats`)).json() as any;
  for (const r of rx) r.ws.close();
  sock.end();

  // ---- assertions ----
  const fail: string[] = [];
  const warm = samples.slice(1);                 // ignore the first sample
  const h0 = warm.length ? Math.min(...warm.map((s) => s.heap)) : final.heapUsedMb;
  const h1 = final.heapUsedMb;
  const growth = h1 - h0;

  const secs = MINUTES * 60;
  const achieved = sent / secs;
  if (achieved < RATE * 0.9) fail.push(`only sustained ${achieved.toFixed(0)}/s of ${RATE}/s`);
  const ingested = final.ingestLines - initial.ingestLines;
  if (ingested < lines * 0.99)
    fail.push(`server saw ${ingested} of ${lines} lines sent`);
  if (growth > Math.max(25, h0 * 0.5))
    fail.push(`heap grew ${growth.toFixed(1)} MB (${h0} -> ${h1}), not flat`);
  if (final.entities > 4096) fail.push(`entity map unbounded: ${final.entities}`);
  if (final.resolveCache > 8192) fail.push(`resolve cache unbounded: ${final.resolveCache}`);
  for (const c of final.clients) {
    if (c.queued > 4) fail.push(`client queue exceeded cap: ${c.queued}`);
  }
  const slowSrv = final.clients.find((c: any) => c.dropped > 0);
  if (!slowSrv) fail.push("backpressure never engaged -- the slow client was served, "
                        + "which means the queue is not actually bounded");
  const fast = rx.filter((r) => !r.slow);
  if (fast.length && fast.every((r) => r.frames === 0))
    fail.push("healthy clients received no frames");
  if (fast.some((r) => r.invalid > 0))
    fail.push("healthy clients received malformed JSON frames");
  if (fast.length && fast.every((r) => r.maxVolumeKb === 0))
    fail.push("byte volume never reached a healthy client");

  console.log("\n---- Phase 3 gate ----");
  console.log(`duration        ${MINUTES} min`);
  console.log(`target rate     ${RATE} events/sec`);
  console.log(`sent            ${sent} (${achieved.toFixed(0)}/s)`);
  console.log(`lines sent      ${lines} (rtt + vol + stat)`);
  console.log(`server ingested ${ingested}`);
  console.log(`frames emitted  ${final.framesOut}`);
  console.log(`heap            ${h0} -> ${h1} MB (delta ${growth >= 0 ? "+" : ""}${growth.toFixed(1)})`);
  console.log(`rss             ${final.rssMb} MB`);
  console.log(`entities        ${final.entities} (cap 4096)`);
  console.log(`resolve cache   ${final.resolveCache} (cap 8192)`);
  console.log(`clients         ${JSON.stringify(final.clients)}`);
  console.log(`rx frames       ${rx.map((r) => `${r.slow ? "slow" : "fast"}:${r.frames}`).join(" ")}`);
  console.log(`write backpressure events ${backpressure}`);

  if (fail.length) {
    console.log("\nPHASE 3 FAIL:");
    for (const f of fail) console.log("  - " + f);
    process.exit(1);
  }
  console.log(`\nPHASE 3 PASS: ${RATE} events/sec for ${MINUTES} min, heap flat, ` +
              `every queue bounded, backpressure drops counted not queued.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
