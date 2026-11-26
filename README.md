# OpsGate

**English** · [简体中文](README.zh-CN.md)

A self-hosted MCP gateway and control plane that exposes infrastructure assets across many categories (Linux hosts, databases, Kubernetes, middleware) to AI agents as one unified surface, with policy enforcement and an audit trail on every call.

One Node process plus SQLite. No Redis, no message queue, no external services.

---

## Contents

- [Why it exists](#why-it-exists)
- [Core design](#core-design)
- [Feature scope](#feature-scope)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Error codes](#error-codes)
- [Development](#development)
- [Documentation](#documentation)
- [Known limitations](#known-limitations)

---

## Why it exists

Connecting infrastructure to AI agents usually hits four problems:

| Problem | Typical consequence |
|---|---|
| **Tool count grows with asset count** | 300 hosts = 300 copies of the same tools; clients hit their tool limit and the context window blows up |
| **Guidance must be shipped to clients** | 20 users each install their own skill / prompt copy, and the versions drift apart |
| **Credentials end up on client machines** | Every user stores a copy of production passwords locally |
| **Calls leave no audit trail** | After an incident you cannot answer "who, when, against which machine, ran what" |

How OpsGate addresses them:

- **Tools aggregated by category**: 300 hosts share one tool set, with the asset demoted to an `asset` argument — tool count is decoupled from asset count
- **Guidance served from the gateway**: `initialize.instructions` is delivered on connection, so clients install nothing
- **Credentials held centrally**: encrypted at rest, bound per asset, injected inside the gateway at call time — callers never see plaintext
- **Audit before execution**: if the audit write fails, the call is refused; there is no degraded path

---

## Core design

### 1. Single entry, layered exposure

`/mcp` is the only MCP endpoint. A bare connection exposes exactly **7 platform tools**, a constant number:

| Tool | Purpose |
|---|---|
| `opsgate_list_assets` | List assets visible to this connection (id / name / category / tags) |
| `opsgate_view_asset` | View a single asset's details (never includes secret values) |
| `opsgate_list_groups` | List groups and their business description |
| `opsgate_view_group` | View a group's composition |
| `opsgate_list_asset_tools` | List the tools available on **one asset**, with parameter schemas |
| `opsgate_invoke` | Run a tool against an asset |
| `opsgate_select_scope` | (Optional) Switch this connection to a full tool set for one scope |

The standard three-step call chain:

```
opsgate_list_assets                → find the target asset
opsgate_list_asset_tools           → see what it can do and how to fill the arguments
opsgate_invoke({asset, tool, args}) → execute
```

This path **does not depend on the client consuming `notifications/tools/list_changed`**, so it works with any MCP client. If a client does support dynamic tool list refreshes, `opsgate_select_scope` can promote the tools of one group / category / tag to first-class tools.

### 2. Native execution first

| Asset type | Execution | Cost per instance | Cold start |
|---|---|---|---|
| `host` (Linux host) | In-process ssh2 connection pool | ~2–5 MB | 100–500 ms |
| `zabbix` / `rocketmq` / `nacos` | In-process HTTP tools | No resident process | Direct request |
| **`cli` (binaries: kubectl / mysql / redis-cli / …)** | **One-shot sandboxed subprocess, `argv` straight to the binary (no shell)** | **0 resident (one process per call)** | **process spawn, ~tens of ms (estimate)** |
| Other community MCP implementations | Spawned subprocess (stdio / http / sse) | ~40–120 MB | 1–30 s (may need to fetch packages) |

Only categories that must reuse a community implementation go through the instance pool. The pool enforces a global budget (instance count / weighted memory / spawn concurrency), idle reclamation, and backoff rebuild on crash.

**CLI assets** are the third execution mode (`execution_mode='cli'`): the asset declares a binary, the caller passes `argv: string[]`, and the gateway runs it once on the gateway host under a `bwrap` sandbox (Linux; refuses to run — never degrades to bare execution — when `bwrap` is unavailable). Credentials reach the process only through environment variables or 0600 temp files, never through `argv`. Each CLI asset exposes exactly one tool, `${category}_run`, and CLI tools are reached through the meta-tool chain only (`opsgate_list_assets` → `opsgate_list_asset_tools` → `opsgate_invoke`), so they never inflate `tools/list`. Details in Spec §5.9.11 and ADR-037.

### 3. Three-tier configuration

| Tier | Carrier | How to change | Examples |
|---|---|---|---|
| **L0** | Environment variables | Edit env vars and restart | Data directory, port, session secret |
| **L1** | `system_settings` table | Takes effect immediately from the runtime settings page (a few need a restart) | Instance budget, transfer limits, audit retention, MCP guidance text |
| **L2** | Code constants | Change code | Error codes, protocol shapes, encryption format |

L1 uses a **declarative schema**: `src/config/settingsSchema.ts` is the single source of truth, and the database stores only rows that deviate from defaults — no row means the default applies. Adding a setting is one line, with zero migrations.

### 4. Single source of truth for authorization

The whole project has exactly one authorization function, `can()` (`src/services/authorize.ts`). Visibility and invoke permission share the same expression: if you can see it, you can call it. There is no "visible but uncallable" or "callable but invisible" mismatch.

---

## Feature scope

### Asset management

- Asset registry: category, execution mode, connection parameters, visibility (`owner` / `group` / `public`), group membership
- Editing is scoped: name, display name, description, tags, connection target (host / port / username / auth slots), URL and the two security switches are editable; **category, execution mode, transport type, command, args, env and headers are fixed at creation** — the PATCH endpoint rejects them outright (400) rather than silently ignoring, so a mis-shaped asset is rebuilt, not mutated
- Bulk enable / disable
- Self-signed TLS certificates supported (enabled explicitly per asset, off by default)

### Credential management

- AES-256-GCM encryption at rest; the key is bound to the local data directory
- **Multiple credentials per slot**: one user can hold both a personal and a shared credential on the same slot
- Binding-level login username (the same credential used with different accounts on different assets)
- Exact key selection (`credential_key`) so renaming a credential cannot silently yield the wrong value
- Credential rotation takes effect immediately (instance keys include a credential fingerprint, so a new instance is built after rotation)

### Groups

Free-form organizational units, not tied to a category. Their job: associate assets, authorize members, filter quickly, and view composition.

### Security policies

Three scope levels × five match dimensions, orthogonal to each other:

| Dimension | Values |
|---|---|
| **Scope** (which assets it applies to) | `global` / `asset_type` / `asset` |
| **Match dimension** (what is matched against) | `tool` (tool name) / `arg` (argument values, expanded recursively) / `body` (entire request body, including key names) / `asset_type` / `group` |
| **Action** | `mark` (flag as high risk) / `block` (refuse the call, returning `-32004`) |

Eight built-in baseline rules ship with the product (cloud metadata endpoints, credential file reads, command injection patterns, uploads to sensitive paths, SQL writes, and more). Administrators may edit or delete them, and deleting is the administrator's responsibility. Regular expressions are validated with `safe-regex2` before being stored, and patterns that could backtrack catastrophically are rejected.

### Audit

- Every call records `who / when / with which credential / against which asset / which tool and arguments`
- **Write-ahead**: a pending record is written before execution; if the audit store is unavailable, the call is refused
- Monthly partitions, configurable retention (6 months by default), automatic cleanup when expired
- Sensitive fields are masked before storage; arguments are truncated per configuration
- Searchable by all five elements, with export and single/bulk delete

### File transfer

File payloads never travel through MCP tool arguments:

```
Request a transfer entry (one-time token, valid 5 minutes) → HTTP PUT/GET the payload → poll status to confirm it landed
```

Per-file limit is configurable (200 MB by default); staging quota and cleanup TTL are configurable.

### Market catalog

23 preset templates (MySQL, K8s, Redis, Docker, Prometheus, RocketMQ, Kafka, Nacos, Zabbix, Baota panel, and more) that can be instantiated in one click. Entries follow a `draft` → `verified` → `disabled` state machine; administrators can create, edit, delete, run connectivity tests, and change status from the admin console.

### Admin console

A React single-page app with 18 pages: a login page + 12 top-level pages (Overview, Assets, Market, Credentials, Groups, Audit, Policies, Settings, Native Tools, Runtime Instances, Members, API Keys) + 5 detail/admin pages (Asset detail, Credential detail, Group detail, Market entry detail, Market admin). Dark-first, with dark / light / follow-system themes.

---

## Tech stack

**Backend**

| Component | Version | Role |
|---|---|---|
| Node.js | ≥ 22 | Runtime |
| TypeScript | 6.0 | Language |
| Fastify | 5.x | HTTP server |
| MCP SDK | 1.32 | MCP protocol implementation |
| Drizzle ORM | 0.44 | Data access |
| better-sqlite3 | 12.x | SQLite driver (WAL) |
| ssh2 | 1.17 | Native SSH / SFTP |
| better-auth | 1.7 | Session authentication |
| Zod | 4.x | Argument validation |

**Frontend**

| Component | Version | Role |
|---|---|---|
| React | 19 | UI framework |
| React Router | 7 | Routing (hash mode) |
| TanStack Query | 5 | Server state |
| Tailwind CSS | 4 | Styling (design-token driven) |
| Vite | 6 | Build |

**Tests**: Vitest 5 — 69 test files, 703 cases (689 passing, 14 skipped).

---

## Quick start

### Docker (recommended)

```bash
cp .env.docker.example .env.docker
```

Edit `.env.docker` and fill in at least two values:

```bash
OPSGATE_SESSION_SECRET=<32+ random characters>
OPSGATE_ADMIN_INIT=admin:<initial password, 10+ characters>
```

Start it:

```bash
docker compose build
docker compose up -d
docker compose logs -f opsgate
```

Once you see `Server listening at http://0.0.0.0:8080`, open `http://<host>:8080`.

Data (SQLite, encryption key, transfer staging area) is persisted in the named volume `opsgate-data`.

### Bare metal

```bash
# Prerequisites: Node 22+, pnpm 10+
pnpm install
pnpm run build
pnpm --dir frontend install && pnpm --dir frontend run build

export OPSGATE_DATA_DIR=/srv/opsgate/data
export OPSGATE_ADMIN_INIT=admin:<initial password, 10+ characters>
pnpm exec tsx src/server.ts
```

The first start runs database migrations automatically and creates the administrator account (only effective when the `users` table is empty).

### Connecting an MCP client

1. Sign in to the console → **API Keys** → create one, then copy the plaintext (shown only once)
2. Configure the client:

```json
{
  "mcpServers": {
    "opsgate": {
      "type": "http",
      "url": "http://<host>:8080/mcp",
      "headers": { "Authorization": "Bearer <API Key>" }
    }
  }
}
```

3. Once connected, start with `opsgate_list_assets`.

You can also initialize directly with a scope filter: `/mcp?category=host`, `/mcp?group=prod`, `/mcp?tag=web`.

---

## Configuration

### Environment variables (L0)

| Variable | Default | Description |
|---|---|---|
| `OPSGATE_DATA_DIR` | `./data` | Data root directory |
| `OPSGATE_DB_PATH` | `<data>/opsgate.db` | SQLite path |
| `OPSGATE_CREDENTIAL_KEY` | `<data>/credentials.key` | Credential encryption key (0600, generated on first start) |
| `OPSGATE_PORT` | `8080` | Listen port |
| `OPSGATE_BIND` | `127.0.0.1` | Listen address |
| `OPSGATE_SESSION_SECRET` | Generated on first start at `<data>/session-secret` | Session signing secret |
| `OPSGATE_ADMIN_INIT` | — | `username:password`, only effective on first start |
| `OPSGATE_LOG_LEVEL` | `info` | `info` / `warn` / `error` |

> Losing `credentials.key` makes existing credentials undecryptable. Always back up the entire data directory.

### Runtime settings (L1)

Adjustable from the console's "Runtime Settings" page: 27 items in 8 groups.

| Group | Representative items |
|---|---|
| Instance pool | Global instance budget, weighted memory budget, instances per asset, queue length per user, idle reclamation TTL, queue timeout, degraded-wait threshold |
| SSH pool | Idle TTL, global concurrency limit |
| Tools | Tool list limit, schema token budget, output truncation bytes, command timeout, disable native tools |
| File transfer | Per-file limit, entry TTL, staging quota, staging cleanup TTL |
| Audit | Retention (months), argument truncation bytes |
| Credentials | Slot limit, user warning threshold |
| MCP | Workflow guidance text (injected into each connection's `initialize.instructions`) |
| General | npm / PyPI mirror sources |

Most items take effect **immediately** without a restart. Items marked "needs restart" show a notice on the page when the saved value differs from the active one.

---

## Architecture

```
                        ┌──────────────────────────────┐
   AI client ───MCP─────▶│  /mcp  (single entry point)   │
   (Bearer API Key)     │  ├─ 7 platform tools          │
                        │  ├─ tool aggregation (by cat) │
                        │  └─ initialize.instructions   │
                        └──────────────┬───────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
     ┌────────────────┐      ┌─────────────────┐     ┌──────────────────┐
     │ Policy engine   │      │  Execution      │     │  Audit (write-   │
     │ scope × dim     │      │  ├─ ssh2 pool   │     │  ahead)          │
     │ block / mark    │      │  ├─ HTTP tools  │     │  monthly tables  │
     └────────────────┘      │  └─ pool spawn  │     │  mask + truncate │
                             └────────┬────────┘     └──────────────────┘
                                      │
                             ┌────────▼────────┐
                             │ Resolve + inject│
                             │ credentials     │
                             │ AES-256-GCM     │
                             └─────────────────┘

   Console (React SPA) ──REST /api/v1──▶ same process
```

**Directory layout**

```
src/
├── app.ts                  Fastify wiring and route registration
├── server.ts               Process entry (config, service wiring, background jobs)
├── config/                 L0 bootstrap, L1 settings schema, L2 constants
├── db/                     Drizzle schema, migrations, seed
├── framework/              Native tool contract and dispatch
├── native/
│   ├── connectors/         ssh2 / HTTP / redis / kafka connectors
│   └── tools/              host / zabbix / rocketmq / nacos / redis / kafka native tools
├── routes/                 REST routes (18 route modules)
└── services/               Domain services (aggregation, instance pool, audit, credentials, policies…)
frontend/
└── src/pages/              18 admin console pages
```

**Key technical decisions** (full records in `docs/adr-*.md`)

| Decision | Content |
|---|---|
| ADR-021 | Aggregate tools by category, demote assets to an argument |
| ADR-022 | Layer native execution vs. proxying community implementations |
| ADR-030 | `?group=` filters by group entity |
| ADR-032 | MCP single entry with layered exposure + `opsgate_select_scope` |
| ADR-033 | Meta-tool `opsgate_invoke`, independent of client tool refresh |
| ADR-035 | Asset shape and execution config are immutable after creation |
| ADR-036 | Native ops capability expansion (Redis/Kafka connectors, raw tools) |
| ADR-037 | CLI assets: `argv` direct execution, `bwrap` sandbox, credentials via env/file only |

---

## Security model

### Defense in depth

1. **Transport**: Bearer API Key (`/mcp`) or session cookie (console); the two are not interchangeable
2. **Authorization**: a single `can()` decision; visible ≡ callable
3. **Policy**: regex matching on tool name / arguments / request body; a `block` hit refuses outright
4. **Audit**: write-ahead — if it cannot be written, it is not executed
5. **Credentials**: decrypted only inside the gateway process, never returned to clients, never written to the audit log
6. **SSRF**: internal addresses and cloud metadata endpoints are blocked by default, with explicit per-asset opt-in

### Deliberately not done

- **No command allowlist**: that belongs to security policies; the execution layer does not make a second judgment
- **No audit degradation**: there is no "temporarily skip audit" switch
- **No role matrix**: identities are either administrator or member
- **No trust in clients**: every constraint is enforced server-side; client-side guidance is advisory only

### High-risk operations

The following are marked `risk=high` and audited by default: delete/write/restart tools, SQL writes, uploads to sensitive paths, and commands that match command-injection patterns.

The built-in guidance text asks the model to restate the target and the full command and wait for user confirmation before executing. Administrators can edit this text on the runtime settings page — after which security management responsibility transfers to the administrator, and the gateway provides no second safety net.

---

## Error codes

MCP call errors use JSON-RPC extension codes:

| Code | Meaning | Suggested action |
|---|---|---|
| `-32002` | Instance busy / queue timeout / connection failed | Narrow the scope and retry |
| `-32003` | Audit unavailable, call refused | Check database health; retrying will not help |
| `-32004` | Blocked by a security policy (`block` rule) | Do not bypass; ask an administrator |
| `-32005` | Tool count exceeds the limit | Narrow with `?tag=` or `?category=` |
| `-32006` | Asset missing or access denied | Do not retry; the two are intentionally indistinguishable to prevent probing |
| `-32007` | File exceeds size limit / staging quota exhausted | Transfer in batches |
| `-32008` | Setting validation failed | Fix according to `message` |

REST endpoints return `{ code, data, message }` uniformly, with `code: 0` meaning success.

---

## Development

```bash
pnpm install                 # install backend dependencies
pnpm --dir frontend install  # install frontend dependencies

pnpm run dev                 # backend dev mode (tsx watch)
pnpm --dir frontend run dev  # frontend dev mode (Vite, proxying /api to 8080)

pnpm run typecheck           # type check
pnpm run lint                # ESLint
pnpm test                    # full test suite
pnpm run check:redlines      # project red-line checks
pnpm run seed                # write seed data (built-in rules, Market catalog)
```

**Test requirements**: `vitest.config.ts` caps concurrency at 4 workers (`maxWorkers: 4`). Running with one worker per CPU core spawns a dozen better-sqlite3 + Fastify instances at once and saturates the machine; the integration tests are I/O-bound, so 4 workers are enough to keep the suite saturated.

**Pre-commit gate**: `typecheck` → `lint` → `test` → `check:redlines` must all pass.

**Adding a setting**: add one line in `src/config/settingsSchema.ts`; no migration needed.

**Adding a native tool**: add a file under `src/native/tools/<category>/`; the description must contain `Use when:` / `Required:` / `Risk:` sections, or startup validation fails.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/opsgate-spec-v1.md`](docs/opsgate-spec-v1.md) | Authoritative design: data model, tool exposure, security constraints, API, acceptance criteria, and all architecture decision records (ADR-001 to ADR-037) in §10 |
| [`docs/deploy.md`](docs/deploy.md) | Deployment, backup, migration, known limitations |

> The documents above are written in Chinese.

---

## Known limitations

- **Linux-only deployment**: Windows is not supported (depends on `tree-kill` and the stdio signal model)
- **Non-interactive shell**: no PTY, so commands requiring interaction are not supported
- **Output truncation**: 4 KB by default, beyond which `truncated: true` is set; narrow the command yourself if you need the full content
- **File transfer relies on the gateway's staging disk**: very large files must be transferred in batches
- **Windows target hosts do not support native SSH execution**
- **CLI assets (ADR-037)**: Linux only; binaries must be pre-installed on the host in this release (the gateway does not install them, so a container deployment needs its own derived image with kubectl / mysql / redis-cli installed); execution goes through a `bwrap` sandbox and is refused when `bwrap` is unavailable; built-in guard rules are synced incrementally on startup (new rules added in code are seeded into an existing database, admin edits and deletions are preserved)
- **Cross-month audit queries scan tables**: with partitioned tables, cross-month search has a performance ceiling
- Bulk import (CSV) and bulk instantiation are v1.1 and not included in v1

---

## License

No open-source license has been designated yet. Contact the maintainer before use.
