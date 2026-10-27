import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "data", "sample.db");
mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });

// Deterministic PRNG so the dataset is identical on every machine.
let seed = 20261026;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const day = 86400000;
const start = Date.UTC(2025, 0, 1);
const end = Date.UTC(2026, 9, 26);
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ts = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

const db = new DatabaseSync(out);
db.exec(`
CREATE TABLE plans (id INTEGER PRIMARY KEY, name TEXT NOT NULL, monthly_price REAL NOT NULL, seat_limit INTEGER);
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, industry TEXT, region TEXT, plan_id INTEGER REFERENCES plans(id), seats INTEGER, created_at TEXT NOT NULL, churned_at TEXT);
CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, hired_at TEXT NOT NULL);
CREATE TABLE tickets (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), agent_id INTEGER REFERENCES agents(id), subject TEXT, category TEXT, priority TEXT, status TEXT, opened_at TEXT NOT NULL, first_response_at TEXT, resolved_at TEXT, csat INTEGER);
CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), amount REAL NOT NULL, status TEXT NOT NULL, issued_at TEXT NOT NULL, due_at TEXT NOT NULL, paid_at TEXT);
CREATE INDEX idx_tickets_customer ON tickets(customer_id);
CREATE INDEX idx_tickets_opened ON tickets(opened_at);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
`);

const plans = [["Starter", 49, 5], ["Team", 199, 25], ["Business", 599, 100], ["Enterprise", 1800, 1000]] as const;
const insPlan = db.prepare("INSERT INTO plans (name, monthly_price, seat_limit) VALUES (?, ?, ?)");
for (const p of plans) insPlan.run(...p);

const first = ["Northwind", "Bluegrass", "Harbor", "Pinecrest", "Summit", "Redwood", "Lakeside", "Ironworks", "Copper", "Granite", "Meridian", "Beacon", "Orchard", "Tidewater", "Prairie", "Cobalt", "Silverline", "Juniper", "Crescent", "Atlas"];
const second = ["Logistics", "Dental", "Analytics", "Foods", "Robotics", "Legal", "Clinics", "Builders", "Media", "Outfitters", "Labs", "Freight", "Studios", "Finance", "Energy", "Health", "Supply", "Systems", "Partners", "Works"];
const industries = ["Healthcare", "Logistics", "Professional Services", "Manufacturing", "Retail", "Software", "Education", "Finance"];
const regions = ["US-Central", "US-East", "US-West", "Canada", "UK", "EU", "ANZ"];

const insCust = db.prepare("INSERT INTO customers (name, industry, region, plan_id, seats, created_at, churned_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
const customers: { id: number; created: number; churned: number | null; plan: number }[] = [];
for (let i = 1; i <= 420; i++) {
  const plan = pick([1, 1, 1, 2, 2, 2, 3, 3, 4]);
  const created = start + Math.floor(rand() * (end - start - 60 * day));
  const churned = rand() < 0.12 ? created + int(60, 400) * day : null;
  const name = `${pick(first)} ${pick(second)}${rand() < 0.3 ? " " + pick(["Inc", "LLC", "Co", "Group"]) : ""}`;
  insCust.run(name, pick(industries), pick(regions), plan, Math.min(plans[plan - 1][2], int(1, 120)), date(created), churned && churned < end ? date(churned) : null);
  customers.push({ id: i, created, churned: churned && churned < end ? churned : null, plan });
}

const agentNames = ["Priya Natarajan", "Marcus Bell", "Sofia Alvarez", "Daniel Okafor", "Hannah Lindqvist", "Tomás Ferreira", "Grace Chen", "Liam O'Connor", "Aisha Rahman", "Ethan Park", "Nadia Petrov", "Owen Walsh"];
const insAgent = db.prepare("INSERT INTO agents (name, team, hired_at) VALUES (?, ?, ?)");
agentNames.forEach((n, i) => insAgent.run(n, i < 7 ? "Tier 1" : i < 10 ? "Tier 2" : "Escalations", date(start - int(30, 900) * day)));

const categories = ["billing", "bug", "how-to", "integration", "performance", "account", "feature-request"];
const subjects: Record<string, string[]> = {
  billing: ["Charged twice this month", "Invoice shows wrong seat count", "Need W-9 for vendor setup", "Refund for unused seats"],
  bug: ["Export to CSV produces empty file", "Dashboard widgets not loading", "Webhook retries stuck", "Search returns stale results"],
  "how-to": ["How do I bulk import contacts", "Setting up SSO with Okta", "Where are audit logs", "Can I schedule reports"],
  integration: ["Salesforce sync dropping fields", "Slack notifications delayed", "API rate limit questions", "Zapier trigger not firing"],
  performance: ["Reports take 2+ minutes", "App slow after 10k records", "Timeouts on large exports"],
  account: ["Add a new admin user", "Transfer ownership", "Reactivate suspended account", "Change billing email"],
  "feature-request": ["Dark mode", "Custom fields on tickets", "Multi-currency invoices", "Granular permissions"],
};
const insTicket = db.prepare("INSERT INTO tickets (customer_id, agent_id, subject, category, priority, status, opened_at, first_response_at, resolved_at, csat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
for (let i = 0; i < 2600; i++) {
  const c = pick(customers);
  const lo = c.created, hi = c.churned ?? end;
  if (hi - lo < day) continue;
  const opened = lo + Math.floor(rand() * (hi - lo));
  const category = pick(categories);
  const priority = pick(["low", "low", "normal", "normal", "normal", "high", "urgent"]);
  const agent = category === "bug" || priority === "urgent" ? int(8, 12) : int(1, 7);
  const firstResp = opened + int(5, priority === "urgent" ? 90 : 720) * 60000;
  const status = rand() < 0.86 ? "resolved" : pick(["open", "pending", "escalated"]);
  const resolved = status === "resolved" ? firstResp + int(1, category === "bug" ? 7200 : 2400) * 60000 : null;
  const csat = resolved && rand() < 0.55 ? (rand() < 0.75 ? int(4, 5) : int(1, 3)) : null;
  insTicket.run(c.id, agent, pick(subjects[category]), category, priority, status, ts(opened), ts(firstResp), resolved ? ts(resolved) : null, csat);
}

const insInv = db.prepare("INSERT INTO invoices (customer_id, amount, status, issued_at, due_at, paid_at) VALUES (?, ?, ?, ?, ?, ?)");
for (const c of customers) {
  const price = plans[c.plan - 1][1];
  let t = c.created;
  const stop = c.churned ?? end;
  while (t < stop) {
    const amount = Math.round(price * (0.9 + rand() * 0.3) * 100) / 100;
    const due = t + 30 * day;
    const r = rand();
    const status = due > end ? "open" : r < 0.88 ? "paid" : r < 0.96 ? "overdue" : "void";
    const paid = status === "paid" ? t + int(1, 35) * day : null;
    insInv.run(c.id, amount, status, date(t), date(due), paid ? date(paid) : null);
    t += 30 * day;
  }
}

const counts = db.prepare("SELECT (SELECT COUNT(*) FROM customers) c, (SELECT COUNT(*) FROM tickets) t, (SELECT COUNT(*) FROM invoices) i").get();
console.log("seeded", out, counts);
db.close();
