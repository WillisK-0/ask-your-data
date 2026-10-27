# ask-your-data

Let Claude answer questions from a real database and a folder of policy docs. Two front doors, one set of tools:

- **MCP server** (`npm run mcp`): plug it into Claude Code or Claude Desktop and ask in plain English. In Claude Desktop the `query` tool renders an interactive panel (sort, filter, chart, click a customer to drill in, draft a reminder) instead of a wall of text. See it at https://bennettworks.io/demo/
- **Web chat** (`npm run serve` + `web/`): a small React UI with a side panel showing every SQL query Claude ran.

No native dependencies. SQLite via Node's built-in `node:sqlite`, so it runs anywhere Node 22+ runs.

## What's inside

```
src/db.ts       read-only SQLite access, schema introspection, keyword doc search
src/tools.ts    four tools defined once: list_tables, describe_table, query, search_docs
src/detail.ts   customer_detail: one customer with totals, tickets and invoices
src/panels.ts   refund queue, refund decisions and ticket creation (in memory; the db stays read-only)
src/mcp.ts      stdio MCP server; four tools are MCP Apps that render the panels below
src/ui/table.html      query results: sort, filter, chart, click a customer to drill in, draft a reminder
src/ui/docs.html       search_docs results with the source section and matching terms highlighted
src/ui/approvals.html  refund_queue: approve, reject or escalate with the policy rule on each request
src/ui/ticket.html     draft_ticket: a form Claude pre-fills and the user confirms
src/smoke-ui.ts    checks the MCP App wiring the way a host would
src/demo-data.ts   builds the canned data for the bennettworks.io demo page
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

### In Claude Desktop, with the interactive panel

Settings › Developer › Edit Config, then add the server and restart the app:

```json
{
  "mcpServers": {
    "ask-your-data": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/ask-your-data/src/mcp.ts"]
    }
  }
}
```

Four tools render panels instead of text:

- **query** → a table you can sort, filter and flip to a chart; click a customer to see their tickets and invoices and draft a payment reminder.
- **search_docs** → the matching handbook sections with the source file, heading and matched terms highlighted.
- **refund_queue** → refund requests with the policy rule on each; approve, reject or escalate from the panel (`decide_refund` records it).
- **draft_ticket** → a ticket form Claude fills from the conversation; you check it and click Create (`create_ticket`).

`npm run smoke:ui` checks all four without Claude.

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
