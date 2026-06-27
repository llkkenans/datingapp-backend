# Dating App — Backend

Production-grade social dating app backend. Built with NestJS, TypeScript (strict mode), Prisma, Supabase PostgreSQL, and Redis.

**Core philosophy: Talk first. Reveal later. Match through conversation quality.**

---

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | NestJS + TypeScript (strict) |
| ORM | Prisma + PostgreSQL (Supabase) |
| Auth | Supabase Auth + JWT |
| Cache / Queues | Redis (ioredis) |
| Realtime | WebSocket (NestJS Gateway) |
| Voice RTC | ZEGOCLOUD / Agora (abstracted) |
| Push | Firebase Cloud Messaging |
| API Docs | Swagger (dev only) |

---

## Prerequisites

- Node.js v18+
- npm v9+
- PostgreSQL (via Supabase or local Docker)
- Redis (local or Docker)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in all values:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL (`https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (keep secret — server only) |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `JWT_SECRET` | Random secret for JWT signing (min 32 chars in production) |
| `JWT_EXPIRES_IN` | Token TTL, e.g. `7d` |
| `REDIS_HOST` | Redis host, e.g. `localhost` |
| `REDIS_PORT` | Redis port, default `6379` |
| `REDIS_PASSWORD` | Redis password (leave empty for local dev) |
| `PORT` | HTTP server port, default `3000` |
| `DATABASE_URL` | PostgreSQL connection string |

### 3. Start Redis (local Docker)

Redis is required for match queues, session state, and presence tracking.

```bash
npm run docker:up
```

This starts the official `redis:7-alpine` container on port `6379` with persistence enabled.

**Verify Redis is running:**

```bash
docker ps
# Look for: datingapp-redis   redis:7-alpine   Up ...   0.0.0.0:6379->6379/tcp
```

Or ping it directly:

```bash
redis-cli ping
# Expected output: PONG
```

**Stop Redis:**

```bash
npm run docker:down
```

**Tail Redis logs:**

```bash
npm run docker:logs
```

> **Note:** This Docker Redis setup is for local development only. Staging and production Redis configuration is covered in Phase 7 deployment setup.

---

### 4. Generate Prisma client

```bash
npm run prisma:generate
```

> Schema models are added in Phase 2. Run this again after schema changes.

### 5. Run in development

```bash
npm run start:dev
```

The server starts at `http://localhost:3000`.  
Swagger docs are available at `http://localhost:3000/api/docs` (dev only).

### 6. Build for production

```bash
npm run build
npm run start:prod
```

---

## Project Structure

```
src/
  app.module.ts          — root module
  main.ts                — bootstrap, Swagger, ValidationPipe
  modules/
    auth/                — authentication (Terminal A)
    users/               — user accounts (Terminal A)
    profiles/            — user profiles (Terminal A)
    onboarding/          — profile completion flow (Terminal A)
    interests/           — interest selection (Terminal A)
    discover/            — social feed (Terminal A)
    messages/            — permanent conversations (Terminal A)
    reports/             — user/content reporting (Terminal A)
    blocks/              — user blocking (Terminal A)
    ratings/             — post-match ratings (Terminal A)
    notifications/       — push notification triggers (Terminal A)
  common/
    guards/              — JWT guard, roles guard
    decorators/          — CurrentUser, Public
    filters/             — global exception filter
    interceptors/        — logging, transform

prisma/
  schema.prisma          — database schema (Phase 2)
  migrations/            — migration history

docs/
  API_CONTRACTS.md
  ARCHITECTURE.md
  DATABASE_SCHEMA.md
  DECISIONS.md
  MATCHING_LOGIC.md
  PHASE_PLAN.md
  PROJECT_OVERVIEW.md
  QA_CHECKLIST.md
  REALTIME_EVENTS.md
  REDIS_KEYS.md
  RTC_PROVIDER.md
```

---

## Available Scripts

```bash
npm run start:dev        # watch mode
npm run start:prod       # production
npm run build            # compile TypeScript
npm run lint             # ESLint + auto-fix
npm run format           # Prettier
npm run test             # Jest unit tests
npm run test:cov         # coverage report
npm run prisma:generate  # generate Prisma client
npm run prisma:migrate   # run migrations (dev)
npm run prisma:studio    # Prisma Studio GUI
npm run docker:up        # start Redis container (detached)
npm run docker:down      # stop Redis container
npm run docker:logs      # tail Redis logs
```

---

## Architecture Principles

- **Flutter = UI only.** All business logic lives in NestJS.
- **NestJS = brain.** Matching eligibility, permissions, RTC tokens, conversation creation, ratings effect — all server-side.
- **Supabase = infrastructure.** PostgreSQL storage, Auth provider, file storage. No duplicate business logic in Edge Functions.
- **Redis = temporary state.** Match queues, active sessions, timers, presence, rate limits.
- **Voice media never passes through NestJS.** Only token generation and session lifecycle.

See `docs/ARCHITECTURE.md` for the full topology.

---

## Terminal Ownership

This backend is managed by **Terminal A** (Backend Core) and **Terminal B** (Realtime / Matching Engine).

- Terminal A owns: `src/modules/` (all non-matching modules), `src/common/`, `docs/API_CONTRACTS.md`
- Terminal B owns: matching, WebSocket gateway, Redis queues, RTC — added in Phase 3/4

See `CLAUDE.md` for the full cross-terminal coordination rules.
