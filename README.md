# OmniBoard

A real-time dashboard that writes events to **PostgreSQL** (relational) and
**MongoDB** (document) side by side and streams both to the browser over
**Socket.io**. It shows row counts, query latency, the latest records and the
health of each database, live.

![stack](https://img.shields.io/badge/stack-Node.js%20%7C%20Express%20%7C%20Socket.io%20%7C%20PostgreSQL%20%7C%20MongoDB-blue)

## Features

* A heartbeat writes one event to each database every 5 s and pushes a fresh
  snapshot to every connected browser.
* "Execute Transaction Block" writes a manual event to both databases at once.
* Each database is checked separately. If one is down the dashboard shows it
  as **DOWN** and keeps working with the other one.
* Old data is cleaned up automatically: a TTL index in MongoDB and a periodic
  `DELETE` in PostgreSQL (default 24 h).
* `GET /healthz` returns 200 when both databases are up and 503 otherwise.
  Docker uses it as the container health check.

## Run with Docker

```bash
cp .env.example .env      # then edit the passwords in .env
docker compose up --build
```

Open http://localhost:8080.

The databases are only reachable inside the Docker network. They are not
published on the host, and Compose refuses to start if the passwords in `.env`
are not set.

## Run locally (without Docker)

Needs Node.js 20+ and running PostgreSQL and MongoDB servers.

```bash
npm install
PG_URI=postgresql://user:pass@localhost:5432/omniboard \
MONGO_URI=mongodb://localhost:27017/omniboard \
npm start
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `PG_URI` | `postgresql://postgres:postgres@localhost:5432/omniboard` | PostgreSQL connection string |
| `MONGO_URI` | `mongodb://localhost:27017/omniboard` | MongoDB connection string |
| `ADMIN_TOKEN` | empty | If set, `POST /api/system-check` needs `Authorization: Bearer <token>` |
| `HEARTBEAT_MS` | `5000` | Heartbeat interval |
| `RETENTION_HOURS` | `24` | How long events are kept |

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/system-check` | Write a manual event to both databases. Rate-limited to 1 per second per client. |
| `GET` | `/healthz` | Health of each database |
| WebSocket | `db-update` event | Dashboard snapshot, pushed on every change |

## Tests

```bash
npm test
```

The tests load the real page in jsdom and check that database values are
rendered as text (no HTML injection), that a database that is down is shown
as down, and that the HTML structure is valid.

## Project structure

```
server.js            Express + Socket.io server, database access, heartbeat
public/index.html    Dashboard layout
public/app.js        Browser client (renders updates safely with textContent)
public/style.css     Styles
docker-compose.yml   App + PostgreSQL 16 + MongoDB 7
test/                Frontend tests
```

## Security notes

This is a portfolio demo, not a hardened service. It does not have user
accounts, and the only protection on the write endpoint is the optional
`ADMIN_TOKEN` plus rate limiting. Put it behind HTTPS and real authentication
before exposing it to the internet.

## Changelog (review fixes, Nov 2026)

* Removed the hard-coded database password and stopped publishing the
  database ports on the host.
* Manual trigger is now `POST` with rate limiting and an optional token
  (it was an open `GET` that wrote to the database).
* Fixed an HTML-injection (XSS) risk: table cells are built with `textContent`.
* Health, CPU and memory now come from real measurements (they were
  hard-coded as "Healthy" and "14%").
* "Throughput" now counts real writes instead of dashboard refreshes.
* Added data retention, startup retries, graceful shutdown, `/healthz`,
  and pinned images (Node 22, PostgreSQL 16, MongoDB 7).
* Fixed the missing `dashboard-wrapper` div and the button label that
  changed after the first click.
