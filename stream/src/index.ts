/*
 * Downlink stream server.
 *
 *   TCP  :9000  tap lines in
 *   WS   :9001  bounded JSON deltas out
 *   HTTP :9002  operator stats
 */
import { createServer as createHttp } from "node:http";
import { createServer as createTcp } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

const INGEST_PORT = Number(process.env.INGEST_PORT ?? 9000);
const WS_PORT = Number(process.env.WS_PORT ?? 9001);
const STATS_PORT = Number(process.env.STATS_PORT ?? 9002);
const RESOLVER = process.env.RESOLVER_URL ?? "http://resolver:8081";

const TICK_MS = 125;
const WINDOW_MS = 2000;
const RETAIN_MS = 30_000;
const MAX_ENTITIES = 4096;
const MAX_RESOLVE_CACHE = 8192;
const MAX_DST_MAP = 16_384;
const CLIENT_QUEUE = 4;
const HIGH_WATER = 1 << 20;

type Method = "route" | "greatcircle" | "pop";
const METHODS = new Set<Method>(["route", "greatcircle", "pop"]);

interface Entity {
  label: string;
  method: Method;
  confidence: number;
  rttMs: number;
  bytesKb: number;
  path: number[];
}

interface Agg {
  label: string;
  method: Method;
  confidence: number;
  path: number[][];
  rtts: { t: number; value: number }[];
  volumes: { t: number; bytes: number }[];
  lastRtt: number;
  lastSeen: number;
  dirty: boolean;
}

const entities = new Map<string, Agg>();
const dstToKey = new Map<string, string>();
const resolveCache = new Map<string, Promise<any>>();
let unmeasuredShare = 0;
let intervalIpv4Bytes = 0;
let lastQuicBytes: number | undefined;
let lastIpv6Bytes: number | undefined;
let ingestLines = 0, ingestDropped = 0, resolveErrors = 0;

function routePath(value: unknown) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const path = value.filter((point): point is number[] =>
    Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
  if (path.length !== value.length) return null;
  if (path.length <= 160) return path;
  return Array.from({ length: 160 }, (_, i) =>
    path[Math.round(i * (path.length - 1) / 159)]!);
}

function capped<K, V>(m: Map<K, V>, k: K, v: V, max: number) {
  if (!m.has(k) && m.size >= max) {
    const oldest = m.keys().next();
    if (!oldest.done) m.delete(oldest.value);
  }
  m.set(k, v);
}

function resolve(ip: string, rttMs: number): Promise<any> {
  const roundedRtt = Math.max(1, Math.round(rttMs));
  const key = `${ip}|${roundedRtt}`;
  const hit = resolveCache.get(key);
  if (hit) return hit;
  const request = fetch(`${RESOLVER}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ip, rtt_ms: roundedRtt }),
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .catch((error) => {
      resolveCache.delete(key);
      resolveErrors++;
      throw error;
    });
  capped(resolveCache, key, request, MAX_RESOLVE_CACHE);
  return request;
}

async function onRtt(ip: string, rttMs: number) {
  let route: any;
  try {
    route = await resolve(ip, rttMs);
  } catch {
    return;
  }
  const path = routePath(route?.path);
  if (!path || !METHODS.has(route.method)) return;

  const key = typeof route.city === "string" && route.city ? route.city : ip;
  capped(dstToKey, ip, key, MAX_DST_MAP);
  const now = Date.now();
  let entity = entities.get(key);
  if (!entity) {
    if (entities.size >= MAX_ENTITIES) {
      let oldestKey: string | undefined, oldest = Infinity;
      for (const [candidate, value] of entities) {
        if (value.lastSeen < oldest) { oldest = value.lastSeen; oldestKey = candidate; }
      }
      if (oldestKey) entities.delete(oldestKey);
    }
    entity = {
      label: typeof route.label === "string" ? route.label.slice(0, 300) : key,
      method: route.method,
      confidence: Number.isFinite(route.confidence)
        ? Math.max(0, Math.min(1, route.confidence)) : 0,
      path,
      rtts: [],
      volumes: [],
      lastRtt: rttMs,
      lastSeen: now,
      dirty: false,
    };
    entities.set(key, entity);
  }
  entity.rtts.push({ t: now, value: rttMs });
  entity.lastRtt = rttMs;
  entity.lastSeen = now;
  entity.label = typeof route.label === "string" ? route.label.slice(0, 300) : entity.label;
  entity.method = route.method;
  if (Number.isFinite(route.confidence))
    entity.confidence = Math.max(0, Math.min(1, route.confidence));
  entity.path = path;
  entity.dirty = true;
}

function onVol(ip: string, bytes: number) {
  intervalIpv4Bytes += bytes;
  const entity = entities.get(dstToKey.get(ip) ?? "");
  if (!entity) return;
  const now = Date.now();
  entity.volumes.push({ t: now, bytes });
  entity.lastSeen = now;
  entity.dirty = true;
}

function counterDelta(value: number, previous: number) {
  return value >= previous ? value - previous : value;
}

function onStat(kv: Record<string, number>) {
  const quic = kv.quic_bytes ?? 0;
  const ipv6 = kv.ipv6_bytes ?? 0;
  if (lastQuicBytes !== undefined && lastIpv6Bytes !== undefined) {
    const unmeasured = counterDelta(quic, lastQuicBytes) +
      counterDelta(ipv6, lastIpv6Bytes);
    const total = intervalIpv4Bytes + counterDelta(ipv6, lastIpv6Bytes);
    unmeasuredShare = total > 0 ? Math.max(0, Math.min(1, unmeasured / total)) : 0;
  }
  lastQuicBytes = quic;
  lastIpv6Bytes = ipv6;
  intervalIpv4Bytes = 0;
}

function positive(value: string | undefined) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function handleLine(line: string) {
  ingestLines++;
  const space = line.indexOf(" ");
  if (space < 0) return;
  const kind = line.slice(0, space);
  const kv: Record<string, string> = {};
  for (const token of line.slice(space + 1).split(" ")) {
    const equals = token.indexOf("=");
    if (equals > 0) kv[token.slice(0, equals)] = token.slice(equals + 1);
  }
  if (kind === "rtt" && kv.dst) {
    const rttUs = positive(kv.rtt_us);
    if (rttUs !== null) void onRtt(kv.dst, rttUs / 1000);
  } else if (kind === "vol" && kv.dst) {
    const bytes = positive(kv.bytes);
    if (bytes !== null) onVol(kv.dst, bytes);
  } else if (kind === "stat") {
    const values: Record<string, number> = {};
    for (const [key, value] of Object.entries(kv)) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) values[key] = n;
    }
    onStat(values);
  }
}

const tcp = createTcp((socket) => {
  socket.setNoDelay(true);
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("latin1");
    if (buffer.length > 1 << 20) { ingestDropped++; buffer = ""; return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
  socket.on("error", () => socket.destroy());
});
tcp.listen(INGEST_PORT, () => console.log(`ingest tcp :${INGEST_PORT}`));

interface Client { ws: WebSocket; queue: string[]; dropped: number }
const clients = new Set<Client>();
const wss = new WebSocketServer({ port: WS_PORT });
wss.on("connection", (ws) => {
  const client: Client = { ws, queue: [], dropped: 0 };
  clients.add(client);
  ws.on("close", () => clients.delete(client));
  ws.on("error", () => { clients.delete(client); ws.terminate(); });
});
console.log(`ws :${WS_PORT}`);

function flush(client: Client) {
  while (client.queue.length && client.ws.bufferedAmount < HIGH_WATER) {
    try { client.ws.send(client.queue.shift()!); }
    catch { client.queue.length = 0; return; }
  }
}

function broadcast(frame: { unmeasured: number; entities: Entity[] }) {
  for (const client of clients) {
    if (client.ws.readyState !== 1) continue;
    while (client.queue.length >= CLIENT_QUEUE) {
      client.queue.shift();
      client.dropped++;
    }
    client.queue.push(JSON.stringify({ ...frame, dropped: client.dropped }));
    flush(client);
  }
}

let framesOut = 0;
setInterval(() => {
  const now = Date.now();
  const out: Entity[] = [];
  for (const [key, entity] of entities) {
    entity.rtts = entity.rtts.filter((sample) => now - sample.t <= WINDOW_MS);
    entity.volumes = entity.volumes.filter((sample) => now - sample.t <= WINDOW_MS);
    if (now - entity.lastSeen > RETAIN_MS) { entities.delete(key); continue; }
    if (!entity.dirty) continue;

    const rttMs = entity.rtts.length
      ? entity.rtts.reduce((sum, sample) => sum + sample.value, 0) / entity.rtts.length
      : entity.lastRtt;
    out.push({
      label: entity.label,
      method: entity.method,
      confidence: entity.confidence,
      rttMs,
      bytesKb: entity.volumes.reduce((sum, sample) => sum + sample.bytes, 0) / 1024,
      path: entity.path.flat(),
    });
    entity.dirty = false;
  }
  if (!out.length) return;
  framesOut++;
  broadcast({ unmeasured: unmeasuredShare, entities: out });
}, TICK_MS);

createHttp((req, res) => {
  if (req.url !== "/stats") { res.writeHead(404).end(); return; }
  const mem = process.memoryUsage();
  const body = JSON.stringify({
    ingestLines, ingestDropped, resolveErrors, framesOut,
    entities: entities.size, resolveCache: resolveCache.size,
    dstMap: dstToKey.size, unmeasuredShare,
    clients: [...clients].map((client) => ({
      queued: client.queue.length,
      dropped: client.dropped,
      buffered: client.ws.bufferedAmount,
    })),
    heapUsedMb: +(mem.heapUsed / 1e6).toFixed(1),
    rssMb: +(mem.rss / 1e6).toFixed(1),
    uptimeS: Math.round(process.uptime()),
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}).listen(STATS_PORT, () => console.log(`stats http :${STATS_PORT}`));
