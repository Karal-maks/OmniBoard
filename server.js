'use strict';

const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Configuration (all from environment; see .env.example)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 8080;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/omniboard';
const PG_URI = process.env.PG_URI || 'postgresql://postgres:postgres@localhost:5432/omniboard';
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 5000;
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS) || 24;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // optional: protects the manual trigger
const MANUAL_MIN_INTERVAL_MS = 1000;               // per-client rate limit
const NODE_NAME = process.env.NODE_NAME || os.hostname();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));

let totalWrites = 0;          // successful inserts since start, across both engines
let pgReady = false;

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------
const mongoLogSchema = new mongoose.Schema({
  eventName: { type: String, maxlength: 100 },
  payload: { type: Object, default: {} },
  // TTL index: MongoDB deletes documents automatically after RETENTION_HOURS
  createdAt: { type: Date, default: Date.now, expires: RETENTION_HOURS * 3600 },
});
const MongoLog = mongoose.model('MongoLog', mongoLogSchema);

mongoose.connection.on('connected', () => console.log('MongoDB connected'));
mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected'));
mongoose.connection.on('error', (err) => console.error('MongoDB error:', err.message));

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------
const pgPool = new Pool({ connectionString: PG_URI, max: 5, connectionTimeoutMillis: 3000 });
pgPool.on('error', (err) => console.error('PostgreSQL pool error:', err.message));

async function initPostgres() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id SERIAL PRIMARY KEY,
      event_name VARCHAR(100) NOT NULL,
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pgPool.query('CREATE INDEX IF NOT EXISTS system_logs_created_at_idx ON system_logs (created_at)');
  pgReady = true;
  console.log('PostgreSQL ready');
}

// Retry until the database is up (containers can start in any order)
async function connectWithRetry(name, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      console.warn(`${name} not ready (${err.message}); retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
async function writeEvent(eventName, pgMetadata, mongoPayload) {
  const results = await Promise.allSettled([
    pgReady
      ? pgPool.query('INSERT INTO system_logs (event_name, metadata) VALUES ($1, $2)', [eventName, pgMetadata])
      : Promise.reject(new Error('PostgreSQL not ready')),
    mongoose.connection.readyState === 1
      ? MongoLog.create({ eventName, payload: mongoPayload })
      : Promise.reject(new Error('MongoDB not connected')),
  ]);
  totalWrites += results.filter((r) => r.status === 'fulfilled').length;
  return results;
}

async function pruneOldRows() {
  if (!pgReady) return;
  await pgPool.query(
    `DELETE FROM system_logs WHERE created_at < now() - ($1 || ' hours')::interval`,
    [String(RETENTION_HOURS)]
  );
}

// ---------------------------------------------------------------------------
// Dashboard snapshot (each engine measured and reported independently)
// ---------------------------------------------------------------------------
async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: Number((performance.now() - start).toFixed(2)) };
}

async function getDashboardData() {
  const [pg, mongo] = await Promise.allSettled([
    timed(async () => {
      if (!pgReady) throw new Error('not ready');
      const [rows, count] = await Promise.all([
        pgPool.query('SELECT id, event_name, metadata, created_at FROM system_logs ORDER BY id DESC LIMIT 8'),
        pgPool.query('SELECT COUNT(*)::int AS n FROM system_logs'),
      ]);
      return { rows: rows.rows, count: count.rows[0].n };
    }),
    timed(async () => {
      if (mongoose.connection.readyState !== 1) throw new Error('not connected');
      const [docs, count] = await Promise.all([
        MongoLog.find().sort({ createdAt: -1 }).limit(8).lean(),
        MongoLog.estimatedDocumentCount(),
      ]);
      return { docs, count };
    }),
  ]);

  const pgOk = pg.status === 'fulfilled';
  const mongoOk = mongo.status === 'fulfilled';
  const load1 = os.loadavg()[0];
  const cpuPercent = Math.min(100, Math.round((load1 / os.cpus().length) * 100));

  return {
    status: pgOk && mongoOk ? 'Operational' : 'Degraded',
    activeConnections: io.engine.clientsCount,
    totalWrites,
    postgresStatus: pgOk ? 'Healthy' : 'Down',
    postgresLogsCount: pgOk ? pg.value.value.count : null,
    postgresLatency: pgOk ? pg.value.ms : null,
    recentPostgres: pgOk ? pg.value.value.rows : [],
    mongoDbStatus: mongoOk ? 'Healthy' : 'Down',
    mongoLogsCount: mongoOk ? mongo.value.value.count : null,
    mongoLatency: mongoOk ? mongo.value.ms : null,
    recentMongo: mongoOk ? mongo.value.value.docs : [],
    host: { cpuPercent, memoryMB: Math.round(process.memoryUsage().rss / 1048576) },
  };
}

async function broadcast() {
  io.emit('db-update', await getDashboardData());
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
io.on('connection', async (socket) => {
  try {
    socket.emit('db-update', await getDashboardData());
  } catch (err) {
    console.error('Initial emit failed:', err.message);
  }
});

// ---------------------------------------------------------------------------
// Heartbeat (sequential: the next tick is scheduled only after this one ends)
// ---------------------------------------------------------------------------
let heartbeatTimer;
async function heartbeat() {
  try {
    const cpu = (os.loadavg()[0] / os.cpus().length * 100).toFixed(0) + '%';
    await writeEvent('Auto Heartbeat Event', `Node: ${NODE_NAME}`, { node: NODE_NAME, cpu_load: cpu });
    await pruneOldRows();
    await broadcast();
  } catch (err) {
    console.error('Heartbeat error:', err.message);
  } finally {
    heartbeatTimer = setTimeout(heartbeat, HEARTBEAT_MS);
  }
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
const lastManualCall = new Map();

function requireToken(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (req.get('authorization') === `Bearer ${ADMIN_TOKEN}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const last = lastManualCall.get(req.ip) || 0;
  if (now - last < MANUAL_MIN_INTERVAL_MS) {
    return res.status(429).json({ error: 'Too many requests, wait a second' });
  }
  lastManualCall.set(req.ip, now);
  if (lastManualCall.size > 10000) lastManualCall.clear(); // bound memory
  return next();
}

// Writes data, so it is POST (a GET must not change state)
app.post('/api/system-check', requireToken, rateLimit, async (req, res) => {
  try {
    const results = await writeEvent('Manual Dispatch', 'User Trigger', { trigger: 'dashboard_button' });
    const data = await getDashboardData();
    io.emit('db-update', data);
    const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
    res.status(failed.length === 2 ? 503 : 200).json({ ok: failed.length === 0, failed, data });
  } catch (err) {
    console.error('Manual dispatch failed:', err);
    res.status(500).json({ error: 'Internal error' }); // do not leak internals to clients
  }
});

app.get('/healthz', async (req, res) => {
  const data = await getDashboardData();
  res.status(data.status === 'Operational' ? 200 : 503).json({
    status: data.status,
    postgres: data.postgresStatus,
    mongo: data.mongoDbStatus,
  });
});

// ---------------------------------------------------------------------------
// Startup and graceful shutdown
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`OmniBoard running on port ${PORT}`);
  connectWithRetry('PostgreSQL', initPostgres);
  connectWithRetry('MongoDB', () => mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 3000 }));
  heartbeat();
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  clearTimeout(heartbeatTimer);
  io.close(); // also closes the underlying HTTP server
  await Promise.allSettled([pgPool.end(), mongoose.disconnect()]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
