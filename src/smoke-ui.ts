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

const res = await client.readResource({ uri: uri! });
const c = res.contents[0] as { mimeType?: string; text?: string };
if (c.mimeType !== "text/html;profile=mcp-app") fail(`resource mimeType = ${c.mimeType}`);
if (!c.text?.includes("ext-apps@1.7.5")) fail("resource HTML does not load the App client");

const r = await client.callTool({ name: "query", arguments: { sql: "SELECT c.id, c.name, c.region, COUNT(i.id) AS overdue FROM customers c JOIN invoices i ON i.customer_id = c.id AND i.status = 'overdue' GROUP BY c.id ORDER BY overdue DESC LIMIT 5" } });
const sc = r.structuredContent as { columns?: string[]; rows?: unknown[] } | undefined;
if (!sc?.rows?.length || !sc.columns?.includes("overdue")) fail("query returned no structuredContent rows");

const d = await client.callTool({ name: "customer_detail", arguments: { id: (sc!.rows![0] as { id: number }).id } });
const dsc = d.structuredContent as { customer?: { name?: string }; tickets?: unknown[]; invoices?: unknown[]; totals?: { paid?: number } } | undefined;
if (!dsc?.customer?.name || !Array.isArray(dsc.tickets) || typeof dsc.totals?.paid !== "number") fail("customer_detail shape");

console.log(`OK: ui=${uri}, html=${c.text!.length} chars, query rows=${sc!.rows!.length}, detail=${dsc!.customer!.name} (${dsc!.tickets!.length} tickets, ${dsc!.invoices!.length} invoices)`);
await client.close();
