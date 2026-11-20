'use strict';

const socket = io();
const $ = (id) => document.getElementById(id);

const BUTTON_LABEL = 'EXECUTE TRANSACTION BLOCK';

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setStatus(id, status) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(status || 'Unknown').toUpperCase();
  el.classList.toggle('healthy', status === 'Healthy');
  el.classList.toggle('degraded', status !== 'Healthy');
}

// Build table rows with textContent only, so database values can never inject HTML
function renderRows(tbody, items, toCells) {
  if (!tbody) return;
  tbody.replaceChildren();
  if (!items || items.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'empty';
    td.textContent = 'No records';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const item of items) {
    const tr = document.createElement('tr');
    for (const cell of toCells(item)) {
      const td = document.createElement('td');
      td.textContent = cell.text;
      if (cell.title) td.title = cell.title;
      if (cell.className) td.className = cell.className;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

const time = (value) => new Date(value).toLocaleTimeString();
const show = (value, suffix = '') => (value === null || value === undefined ? '--' : `${value}${suffix}`);

socket.on('connect', () => {
  setText('connectionStatus', 'WebSockets Live');
  document.body.classList.remove('offline');
});

socket.on('disconnect', () => {
  setText('connectionStatus', 'Disconnected - reconnecting...');
  document.body.classList.add('offline');
});

socket.on('connect_error', (err) => {
  console.error('WebSocket connection error:', err.message);
});

socket.on('db-update', (data) => {
  if (!data) return;

  setText('pgCount', show(data.postgresLogsCount));
  setText('pgLatVal', `Latency: ${show(data.postgresLatency, ' ms')}`);
  setText('mongoCount', show(data.mongoLogsCount));
  setText('mongoLatVal', `Latency: ${show(data.mongoLatency, ' ms')}`);
  setText('activeClients', show(data.activeConnections));
  setText('throughput', show(data.totalWrites));

  if (data.host) {
    setText('cpuLoad', `${data.host.cpuPercent}%`);
    setText('memUsage', `${data.host.memoryMB} MB`);
  }

  setStatus('pgHealth', data.postgresStatus);
  setStatus('mongoHealth', data.mongoDbStatus);

  renderRows(document.querySelector('#pgTable tbody'), data.recentPostgres, (row) => [
    { text: String(row.id) },
    { text: row.event_name },
    { text: row.metadata || 'N/A', className: 'muted' },
    { text: time(row.created_at) },
  ]);

  renderRows(document.querySelector('#mongoTable tbody'), data.recentMongo, (doc) => [
    { text: `${String(doc._id).substring(0, 8)}...`, title: String(doc._id) },
    { text: doc.eventName },
    { text: JSON.stringify(doc.payload), className: 'json' },
    { text: time(doc.createdAt) },
  ]);
});

const runCheckBtn = $('runCheckBtn');
if (runCheckBtn) {
  runCheckBtn.addEventListener('click', async () => {
    runCheckBtn.disabled = true;
    runCheckBtn.textContent = 'DISPATCHING...';
    try {
      const res = await fetch('/api/system-check', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        runCheckBtn.textContent = body.error ? `FAILED: ${body.error}` : `FAILED (${res.status})`;
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (error) {
      console.error('Manual transaction failed:', error);
    } finally {
      runCheckBtn.textContent = BUTTON_LABEL;
      runCheckBtn.disabled = false;
    }
  });
}
