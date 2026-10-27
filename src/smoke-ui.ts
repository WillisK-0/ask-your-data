// Checks the MCP App wiring the way a host would: the query tool advertises a ui:// resource,
// the resource reads back as an MCP App, query returns structuredContent, and customer_detail works.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "smoke-ui", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", join(here, "mcp.ts")], stderr: "ignore" }));

const fail = (m: string): never => { console.error("FAIL:", m); process.exit(1); };

const { tools } = await client.listTools();
const q = tools.find((t) => t.name === "query");
if (!q) fail("no query tool");
const uri = (q!._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
if (uri !== "ui://ask-your-data/table") fail(`query _meta.ui.resourceUri = ${uri}`);
if (!tools.some((t) => t.name === "customer_detail")) fail("no customer_detail tool");

const expect: Record<string, string> = { query: "ui://ask-your-data/table", search_docs: "ui://ask-your-data/docs", refund_queue: "ui://ask-your-data/approvals", draft_ticket: "ui://ask-your-data/ticket" };
for (const [tool, want] of Object.entries(expect)) {
  const t = tools.find((x) => x.name === tool); if (!t) fail(`no ${tool} tool`);
  const got = (t!._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri; if (got !== want) fail(`${tool} ui = ${got}`);
  const rr = await client.readResource({ uri: want }); const cc = rr.contents[0] as { mimeType?: string; text?: string };
  if (cc.mimeType !== "text/html;profile=mcp-app" || !cc.text?.includes("ext-apps@1.7.5")) fail(`${want} resource is not an MCP App`);
}
const res = await client.readResource({ uri: uri! });
const c = res.contents[0] as { mimeType?: string; text?: string };
const sd = await client.callTool({ name: "search_docs", arguments: { query: "duplicate charge refund limit" } });
if (!((sd.structuredContent as { results?: unknown[] })?.results?.length)) fail("search_docs returned no results");
const rq = await client.callTool({ name: "refund_queue", arguments: {} });
const reqs = (rq.structuredContent as { requests?: { id: number; can_approve: boolean }[] })?.requests ?? [];
if (!reqs.length) fail("refund_queue empty");
const dec = await client.callTool({ name: "decide_refund", arguments: { id: reqs[0].id, decision: "approved" } });
if ((dec.structuredContent as { status?: string })?.status !== "approved") fail("decide_refund did not record");
const ct = await client.callTool({ name: "create_ticket", arguments: { customer_id: 175, subject: "smoke", category: "bug", priority: "normal", body: "x" } });
if (typeof (ct.structuredContent as { id?: number })?.id !== "number") fail("create_ticket returned no id");

const r = await client.callTool({ name: "query", arguments: { sql: "SELECT c.id, c.name, c.region, COUNT(i.id) AS overdue FROM customers c JOIN invoices i ON i.customer_id = c.id AND i.status = 'overdue' GROUP BY c.id ORDER BY overdue DESC LIMIT 5" } });
const sc = r.structuredContent as { columns?: string[]; rows?: unknown[] } | undefined;
if (!sc?.rows?.length || !sc.columns?.includes("overdue")) fail("query returned no structuredContent rows");

const d = await client.callTool({ name: "customer_detail", arguments: { id: (sc!.rows![0] as { id: number }).id } });
const dsc = d.structuredContent as { customer?: { name?: string }; tickets?: unknown[]; invoices?: unknown[]; totals?: { paid?: number } } | undefined;
if (!dsc?.customer?.name || !Array.isArray(dsc.tickets) || typeof dsc.totals?.paid !== "number") fail("customer_detail shape");

console.log(`OK: 4 panels advertised and readable; search_docs, refund_queue (${reqs.length}), decide_refund, create_ticket work; html=${c.text!.length} chars, query rows=${sc!.rows!.length}, detail=${dsc!.customer!.name} (${dsc!.tickets!.length} tickets, ${dsc!.invoices!.length} invoices)`);
await client.close();
