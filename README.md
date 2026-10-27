# ask-your-data

Let Claude answer questions from a real database and a folder of policy docs. Two front doors, one set of tools:

- **MCP server** (`npm run mcp`): plug it into Claude Code or Claude Desktop and ask in plain English.
- **Web chat** (`npm run serve` + `web/`): a small React UI with a side panel showing every SQL query Claude ran.

No native dependencies. SQLite via Node's built-in `node:sqlite`, so it runs anywhere Node 22+ runs.

## What's inside

```
src/db.ts       read-only SQLite access, schema introspection, keyword doc search
src/tools.ts    four tools defined once: list_tables, describe_table, query, search_docs
src/mcp.ts      stdio MCP server exposing those tools
src/server.ts   Express /api/chat using the Anthropic SDK tool runner with the same tools
src/seed.ts     deterministic sample dataset: 420 customers, 2,600 tickets, 4,878 invoices
src/smoke.ts    spawns the MCP server like a client would and exercises every tool
docs/           refund policy, SLAs, escalation runbook (the "RAG" half)
web/            Vite + React chat UI
```

The `query` tool only accepts `SELECT`/`WITH`, opens the database read-only, runs each query in a child process that is killed after 5 seconds, allows two concurrent queries, and caps results at 200 rows. The HTTP server binds to loopback, validates every turn, and rate-limits per IP; set `HOST=0.0.0.0` and `ASK_TOKEN=<secret>` to expose it. Swap `ReadOnlyDb` for a Postgres or SQL Server adapter and nothing else changes.

## Run it

```bash
npm install
npm run seed      # builds data/sample.db
npm run smoke     # proves the MCP server works end to end, no API key needed
```

### As an MCP server in Claude Code

```bash
claude mcp add ask-your-data -- npx tsx /absolute/path/to/src/mcp.ts
```

Then ask: *"Which customers have overdue invoices and an open urgent ticket?"*

### As a web app

```bash
export ANTHROPIC_API_KEY=...
npm run serve                 # API on :3000
cd web && npx vite            # UI on :5173, proxies /api
```

## Why this shape

Most "chat with your data" demos hide the SQL. Operators don't trust what they can't see, so the UI shows every tool call. Defining tools once and adapting them to both MCP and the Anthropic SDK means the connector you ship to Claude Desktop and the one behind your internal web app can't drift apart.
