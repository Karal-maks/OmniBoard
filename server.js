const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

let activeConnections = 0;
let totalThroughput = 0;

// 1. Connect to MongoDB
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/omniboard')
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('Mongo Error:', err));

const mongoLogSchema = new mongoose.Schema({
  eventName: String,
  payload: { type: Object, default: { source: 'telemetry_daemon', status: 'nominal' } },
  createdAt: { type: Date, default: Date.now }
});
const MongoLog = mongoose.model('MongoLog', mongoLogSchema);

// 2. Connect to PostgreSQL using a robust Pool (prevents connection drops/freezes)
const pgPool = new Pool({
  connectionString: process.env.PG_URI || 'postgresql://postgres:secret@postgres-db:5432/omniboard'
});

pgPool.connect().then(client => {
  console.log('PostgreSQL Pool Connected');
  client.release();
  return pgPool.query(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id SERIAL PRIMARY KEY,
      event_name VARCHAR(100),
      metadata TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}).catch(err => console.error('PG Pool Error:', err));

// Comprehensive Data Collector
async function getDashboardData() {
  const pgStart = performance.now();
  const pgRes = await pgPool.query('SELECT * FROM system_logs ORDER BY created_at DESC LIMIT 8');
  const pgCountRes = await pgPool.query('SELECT COUNT(*) FROM system_logs');
  const pgLatency = (performance.now() - pgStart).toFixed(2);

  const mongoStart = performance.now();
  const mongoRecent = await MongoLog.find().sort({ createdAt: -1 }).limit(8);
  const mongoCount = await MongoLog.countDocuments();
  const mongoLatency = (performance.now() - mongoStart).toFixed(2);

  return {
    status: 'Operational',
    activeConnections,
    totalThroughput: ++totalThroughput,
    postgresLogsCount: pgCountRes.rows[0].count,
    postgresLatency: pgLatency,
    mongoLogsCount: mongoCount,
    mongoLatency: mongoLatency,
    mongoDbStatus: mongoose.connection.readyState === 1 ? 'Healthy' : 'Degraded',
    postgresStatus: 'Healthy',
    recentPostgres: pgRes.rows,
    recentMongo: mongoRecent
  };
}

io.on('connection', async (socket) => {
  activeConnections++;
  try {
    socket.emit('db-update', await getDashboardData());
  } catch (err) {
    console.error('Socket initial emit error:', err);
  }

  socket.on('disconnect', () => {
    activeConnections--;
  });
});

// Automated Heartbeat Tick (Runs every 5 seconds without freezing)
setInterval(async () => {
  try {
    await pgPool.query('INSERT INTO system_logs (event_name, metadata) VALUES ($1, $2)', ['Auto Heartbeat Event', 'Node: auto-worker-01']);
    await MongoLog.create({ eventName: 'Auto Heartbeat Event', payload: { node: 'auto-worker-01', cpu_load: '14%' } });

    const data = await getDashboardData();
    io.emit('db-update', data);
  } catch (err) {
    console.error('Background heartbeat error:', err);
  }
}, 5000);

// Manual Trigger Endpoint
app.get('/api/system-check', async (req, res) => {
  try {
    await pgPool.query('INSERT INTO system_logs (event_name, metadata) VALUES ($1, $2)', ['Manual Dispatch', 'User Trigger']);
    await MongoLog.create({ eventName: 'Manual Dispatch', payload: { trigger: 'dashboard_button', user: 'admin' } });

    const data = await getDashboardData();
    io.emit('db-update', data);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

server.listen(process.env.PORT || 8080, () => {
  console.log(`OmniBoard running on port ${process.env.PORT || 8080}`);
});