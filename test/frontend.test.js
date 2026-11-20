'use strict';
// Renders public/index.html + public/app.js in jsdom with a stubbed Socket.io
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', 'public');

function load() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const handlers = {};
  dom.window.io = () => ({ on: (event, fn) => (handlers[event] = fn) });
  dom.window.eval(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  return { doc: dom.window.document, handlers };
}

const sample = (overrides = {}) => ({
  postgresLogsCount: 3, postgresLatency: 1.2, mongoLogsCount: 4, mongoLatency: 0.8,
  activeConnections: 2, totalWrites: 9, postgresStatus: 'Healthy', mongoDbStatus: 'Healthy',
  host: { cpuPercent: 7, memoryMB: 80 }, recentPostgres: [], recentMongo: [], ...overrides,
});

test('HTML has balanced div tags', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.strictEqual((html.match(/<div\b/g) || []).length, (html.match(/<\/div>/g) || []).length);
});

test('database values are rendered as text, never as HTML', () => {
  const { doc, handlers } = load();
  const evil = '<img src=x onerror=alert(1)>';
  handlers['db-update'](sample({
    recentPostgres: [{ id: 1, event_name: evil, metadata: evil, created_at: new Date() }],
    recentMongo: [{ _id: 'abcdef0123456789', eventName: evil, payload: { x: evil }, createdAt: new Date() }],
  }));
  assert.strictEqual(doc.querySelectorAll('img').length, 0);
  assert.strictEqual(doc.querySelector('#pgTable td:nth-child(2)').textContent, evil);
});

test('a down database is shown as down, not healthy', () => {
  const { doc, handlers } = load();
  handlers['db-update'](sample({ mongoDbStatus: 'Down', mongoLogsCount: null, mongoLatency: null }));
  assert.strictEqual(doc.getElementById('mongoHealth').textContent, 'DOWN');
  assert.ok(doc.getElementById('mongoHealth').classList.contains('degraded'));
  assert.strictEqual(doc.getElementById('mongoCount').textContent, '--');
});

test('host metrics come from the server, not hard-coded', () => {
  const { doc, handlers } = load();
  handlers['db-update'](sample({ host: { cpuPercent: 42, memoryMB: 123 } }));
  assert.strictEqual(doc.getElementById('cpuLoad').textContent, '42%');
  assert.strictEqual(doc.getElementById('memUsage').textContent, '123 MB');
});
