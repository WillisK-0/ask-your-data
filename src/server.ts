// HTTP chat endpoint: same tools as the MCP server, driven by the Anthropic SDK tool runner.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { ReadOnlyDb, DocSearch } from "./db.js";
import { makeTools } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const db = new ReadOnlyDb(process.env.ASK_DB ?? join(here, "..", "data", "sample.db"));
const docs = new DocSearch(process.env.ASK_DOCS ?? join(here, "..", "docs"));
const client = new Anthropic();

const SYSTEM = `You answer questions about a company's customers, support tickets, invoices, and policies.
Use the tools. Start with list_tables if you don't know the schema. Prefer one well-aggregated SQL query over many small ones.
Quote numbers exactly as returned. If a question is about policy or process, use search_docs and cite the document heading.
Answer in plain prose with at most one short table. Say what you queried in one line at the end.`;

const tools = makeTools(db, docs).map((t) =>
  betaZodTool({
    name: t.name,
    description: t.description,
    inputSchema: z.object(t.shape),
    run: async (input) => {
      try { return await t.run(input as never); }
      catch (err) { return `Error: ${(err as Error).message}`; }
    },
  }),
);

interface Trace { tool: string; input: unknown; }

// Client turns are validated and rebuilt here; the browser never controls roles, tools, or system prompt.
const TurnSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) });
const BodySchema = z.object({ messages: z.array(TurnSchema).min(1).max(40) });

// Simple per-IP rate limit; enough for a demo, swap for a real limiter behind a proxy.
const hits = new Map<string, number[]>();
function rateLimited(ip: string, max = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > max;
}

const app = express();
app.use(express.json({ limit: "64kb" }));

app.post("/api/chat", async (req, res) => {
  const token = process.env.ASK_TOKEN;
  if (token && req.get("authorization") !== `Bearer ${token}`) { res.status(401).json({ error: "unauthorized" }); return; }
  if (rateLimited(req.ip ?? "unknown")) { res.status(429).json({ error: "Too many requests. Try again in a minute." }); return; }
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "messages must be 1 to 40 turns of {role, content}" }); return; }
  if (parsed.data.messages[0].role !== "user") { res.status(400).json({ error: "first turn must be from the user" }); return; }
  const messages: Anthropic.Beta.BetaMessageParam[] = parsed.data.messages.map((m) => ({ role: m.role, content: m.content }));
  const trace: Trace[] = [];
  try {
    const runner = client.beta.messages.toolRunner({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system: SYSTEM,
      tools,
      messages,
      max_iterations: 12,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    for await (const message of runner) {
      for (const block of message.content) {
        if (block.type === "tool_use") trace.push({ tool: block.name, input: block.input });
      }
    }
    const final = await runner.done();
    const text = final.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    res.json({ text, trace, stop_reason: final.stop_reason, usage: final.usage });
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? err.status : 500;
    res.status(status ?? 500).json({ error: (err as Error).message, trace });
  }
});

const dist = join(here, "..", "web", "dist");
if (existsSync(dist)) app.use(express.static(dist));

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1"; // loopback by default; set HOST=0.0.0.0 and ASK_TOKEN to expose it
app.listen(port, host, () => console.log(`ask-your-data on http://${host}:${port}`));
