// Builds the canned conversation data for bennettworks.io/demo: four prompts, the SQL Claude would write,
// the real result rows from the sample database, and the customer_detail payload for every customer those rows mention.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { ReadOnlyDb } from "./db.js";
import { customerDetail } from "./detail.js";
import { DocSearch } from "./db.js";
import { refundQueue } from "./panels.js";

const here = dirname(fileURLToPath(import.meta.url));
const db = new ReadOnlyDb(process.env.ASK_DB ?? join(here, "..", "data", "sample.db"));
const docs = new DocSearch(process.env.ASK_DOCS ?? join(here, "..", "docs"));
const out = process.argv[2] ?? join(here, "..", "..", "site-v2", "demo", "data.json");

const scenarios = [
  { id: "support", label: "Support", who: "Support lead", view: "table", prompts: [
    { id: "risk", ask: "Which customers have an overdue invoice and an open urgent ticket right now?",
      reply: "{n} customers are in that spot. The ones at the top have the most money outstanding, so I'd start there. Click any row to open the customer, then Draft reminder if you want to chase the invoice.",
      sql: `SELECT c.id, c.name, c.region, p.name AS plan,
       COUNT(DISTINCT i.id) AS overdue_invoices,
       ROUND(SUM(DISTINCT i.amount), 2) AS amount_overdue,
       COUNT(DISTINCT t.id) AS urgent_open,
       MIN(substr(t.opened_at, 1, 10)) AS oldest_urgent
FROM customers c
JOIN plans p ON p.id = c.plan_id
JOIN invoices i ON i.customer_id = c.id AND i.status = 'overdue'
JOIN tickets t ON t.customer_id = c.id AND t.priority = 'urgent' AND t.status IN ('open', 'pending', 'escalated')
WHERE c.churned_at IS NULL
GROUP BY c.id
ORDER BY amount_overdue DESC
LIMIT 50` },
    { id: "tickets", ask: "How are tickets spread across category and priority this quarter, and how long do they take to resolve?",
      reply: "This quarter's tickets by category and priority, with resolution time and CSAT for each. Use the chips to narrow to one priority, or sort by hours to see what sits longest.",
      sql: `SELECT category, priority,
       COUNT(*) AS tickets,
       SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
       ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN (julianday(resolved_at) - julianday(opened_at)) * 24 END), 1) AS avg_hours_to_resolve,
       ROUND(AVG(csat), 2) AS avg_csat
FROM tickets
WHERE opened_at >= '2026-07-01'
GROUP BY category, priority
ORDER BY tickets DESC` },
    { id: "agents", ask: "Which agents are carrying the most open escalated tickets, and how are their CSAT scores?",
      reply: "Open and escalated tickets per agent, with each agent's average CSAT on resolved work. The load is uneven. Sort by escalated to see who needs help first.",
      sql: `SELECT a.name AS agent, a.team,
       SUM(CASE WHEN t.status IN ('open', 'pending') THEN 1 ELSE 0 END) AS open_tickets,
       SUM(CASE WHEN t.status = 'escalated' THEN 1 ELSE 0 END) AS escalated,
       ROUND(AVG(CASE WHEN t.status = 'resolved' THEN t.csat END), 2) AS avg_csat,
       COUNT(*) AS all_time
FROM agents a
LEFT JOIN tickets t ON t.agent_id = a.id
GROUP BY a.id
ORDER BY escalated DESC, open_tickets DESC` },
    { id: "newticket", ui: "ticket", tool: "draft_ticket", ask: "Harbor Outfitters just emailed that their webhook retries are stuck again. Open an urgent ticket for them.",
      reply: "I've drafted the ticket from their history: it's the same webhook issue as ticket 531, still open. Check the fields and hit Create, or fix anything I got wrong first.",
      draft: { customer_id: 175, customer: "Harbor Outfitters", subject: "Webhook retries stuck again (follow-up to #531)", category: "integration", priority: "urgent", body: "Customer reports webhook retries are stuck again. Ticket 531 (bug, opened 2026-04-07) is still open for the same symptom. Enterprise plan, 41 seats, 4 overdue invoices. Needs an engineer to check the retry queue and confirm whether this is the same root cause." } },
  ]},
  { id: "policy", label: "Policy", who: "New support agent", view: "table", prompts: [
    { id: "dup", ui: "docs", tool: "search_docs", ask: "A customer was charged twice for $450. Can I just refund it, or do I need to ask someone?",
      reply: "You can approve that yourself. The refund policy says Tier 1 agents may approve duplicate-charge refunds up to $600 without escalation, and it goes back in full within 5 business days once Billing confirms the duplicate. The section is highlighted in the panel.",
      query: "duplicate charge refund approve without escalation" },
    { id: "escalate", ui: "docs", tool: "search_docs", ask: "When am I supposed to escalate an urgent ticket?",
      reply: "Two triggers from the runbook: any urgent ticket older than 4 hours without a resolution, or any Enterprise customer with CSAT below 3. Set it to escalated, assign an Escalations agent, and don't promise a timeline until Tier 2 has triaged.",
      query: "escalate urgent ticket hours escalations team" },
    { id: "sla", ui: "docs", tool: "search_docs", ask: "What's the first-response target for a High ticket from a Business-plan customer?",
      reply: "Four business hours for High, and Business-plan customers also get a named escalation contact. The 30-minute target only applies to urgent tickets. Both sections are in the panel with the matching lines highlighted.",
      query: "first response target high business hours plan" },
  ]},
  { id: "billing", label: "Billing", who: "Billing approver", view: "table", prompts: [
    { id: "refunds", ui: "approvals", tool: "refund_queue", ask: "Show me the refund requests waiting on me.",
      reply: "{n} requests are pending. Each one shows the policy rule that applies, so the ones you can approve on your own have Approve enabled and the rest offer Escalate. Decisions are recorded as you click.",
      sql: "" },
  ]},
  { id: "finance", label: "Finance", who: "Finance", view: "chart", prompts: [
    { id: "revenue", ask: "Show me paid revenue by region and plan for 2026.",
      reply: "2026 paid revenue by region and plan, {n} combinations. The chart groups by region; switch it to plan or flip to the table for the exact numbers.",
      sql: `SELECT c.region, p.name AS plan,
       COUNT(DISTINCT c.id) AS customers,
       COUNT(i.id) AS invoices,
       ROUND(SUM(i.amount), 2) AS revenue
FROM invoices i
JOIN customers c ON c.id = i.customer_id
JOIN plans p ON p.id = c.plan_id
WHERE i.status = 'paid' AND i.paid_at >= '2026-01-01'
GROUP BY c.region, p.name
ORDER BY revenue DESC` },
    { id: "monthly", ask: "What does paid revenue look like month by month over the last twelve months?",
      reply: "Monthly paid revenue for the trailing twelve months, with the number of invoices behind each bar. Sort the table by month to read it in order.",
      sql: `SELECT substr(paid_at, 1, 7) AS month,
       COUNT(*) AS invoices,
       ROUND(SUM(amount), 2) AS revenue
FROM invoices
WHERE status = 'paid' AND paid_at >= date('2026-10-25', '-12 months')
GROUP BY month
ORDER BY month` },
    { id: "overdue", ask: "How much is overdue right now, by region?",
      reply: "Overdue invoices by region: how many, how much, and how old the oldest one is. The chart shows the dollar amount; flip to the table for the counts.",
      sql: `SELECT c.region,
       COUNT(i.id) AS overdue_invoices,
       COUNT(DISTINCT c.id) AS customers,
       ROUND(SUM(i.amount), 2) AS amount_overdue,
       MIN(substr(i.due_at, 1, 10)) AS oldest_due
FROM invoices i
JOIN customers c ON c.id = i.customer_id
WHERE i.status = 'overdue'
GROUP BY c.region
ORDER BY amount_overdue DESC` },
  ]},
  { id: "sales", label: "Sales", who: "Account manager", view: "table", prompts: [
    { id: "top", ask: "Who are our 20 biggest customers by lifetime paid revenue, and do any of them have open tickets?",
      reply: "Your top 20 by lifetime paid revenue. The open_tickets column shows who has something unresolved right now, and avg_csat is their average rating, so a low number next to a big account is worth a call.",
      sql: `SELECT c.id, c.name, c.industry, c.region, p.name AS plan,
       ROUND(SUM(CASE WHEN i.status = 'paid' THEN i.amount ELSE 0 END), 2) AS paid_revenue,
       (SELECT COUNT(*) FROM tickets t WHERE t.customer_id = c.id AND t.status IN ('open', 'pending', 'escalated')) AS open_tickets,
       (SELECT ROUND(AVG(csat), 1) FROM tickets t WHERE t.customer_id = c.id AND csat IS NOT NULL) AS avg_csat
FROM customers c
JOIN plans p ON p.id = c.plan_id
JOIN invoices i ON i.customer_id = c.id
GROUP BY c.id
ORDER BY paid_revenue DESC
LIMIT 20` },
    { id: "churn", ask: "Which customers churned in the last six months, and what were they paying us?",
      reply: "{n} customers churned since April. Lifetime paid is what we lost; the CSAT and ticket columns hint at why. Click one to see what their last few tickets were about.",
      sql: `SELECT c.id, c.name, c.industry, c.region, p.name AS plan,
       substr(c.churned_at, 1, 10) AS churned,
       ROUND(SUM(CASE WHEN i.status = 'paid' THEN i.amount ELSE 0 END), 2) AS lifetime_paid,
       (SELECT COUNT(*) FROM tickets t WHERE t.customer_id = c.id) AS tickets,
       (SELECT ROUND(AVG(csat), 1) FROM tickets t WHERE t.customer_id = c.id AND csat IS NOT NULL) AS avg_csat
FROM customers c
JOIN plans p ON p.id = c.plan_id
LEFT JOIN invoices i ON i.customer_id = c.id
WHERE c.churned_at >= '2026-04-25'
GROUP BY c.id
ORDER BY lifetime_paid DESC` },
    { id: "upsell", ask: "Which Team-plan customers are near their seat limit and have no open tickets? Those are my upsell calls.",
      reply: "{n} Team-plan accounts are at 80% or more of their seat limit with nothing open in support. Sorted by how full they are. Good list for a Friday.",
      sql: `SELECT c.id, c.name, c.industry, c.region, c.seats, p.seat_limit,
       ROUND(100.0 * c.seats / p.seat_limit, 0) AS pct_of_limit,
       substr(c.created_at, 1, 10) AS customer_since
FROM customers c
JOIN plans p ON p.id = c.plan_id
WHERE p.name = 'Team' AND c.churned_at IS NULL AND p.seat_limit IS NOT NULL
  AND c.seats >= 0.8 * p.seat_limit
  AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.customer_id = c.id AND t.status IN ('open', 'pending', 'escalated'))
ORDER BY pct_of_limit DESC, c.seats DESC
LIMIT 50` },
  ]},
];

const details: Record<string, unknown> = {};
const outScenarios = [];
for (const sc of scenarios) {
  const prompts = [];
  for (const p of sc.prompts as Array<Record<string, unknown> & { id: string; ui?: string; tool?: string; sql?: string; query?: string; draft?: unknown }>) {
    const ui = p.ui ?? "table", tool = p.tool ?? "query";
    if (ui === "table") {
      const { rows, truncated } = await db.query(p.sql!);
      const columns = rows.length ? Object.keys(rows[0] as object) : [];
      prompts.push({ ...p, ui, tool, args: { sql: p.sql }, result: { sql: p.sql, columns, rows, rowCount: rows.length, truncated } });
      for (const r of rows as Record<string, unknown>[]) {
        const id = r.id ?? r.customer_id;
        if (typeof id === "number" && !details[id]) details[id] = await customerDetail(db, id);
      }
      console.log(sc.id, p.id, rows.length, "rows");
    } else if (ui === "docs") {
      const results = docs.search(p.query!, 3);
      prompts.push({ ...p, ui, tool, args: { query: p.query }, result: { query: p.query, results, rowCount: results.length } });
      console.log(sc.id, p.id, results.length, "sections");
    } else if (ui === "approvals") {
      const requests = await refundQueue(db);
      prompts.push({ ...p, ui, tool, args: {}, result: { requests, rowCount: requests.length } });
      for (const r of requests) if (!details[r.customer_id]) details[r.customer_id] = await customerDetail(db, r.customer_id);
      console.log(sc.id, p.id, requests.length, "requests");
    } else if (ui === "ticket") {
      prompts.push({ ...p, ui, tool, args: p.draft, result: { ...(p.draft as object), rowCount: 1 } });
      console.log(sc.id, p.id, "ticket draft");
    }
  }
  outScenarios.push({ ...sc, prompts });
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ built_at: new Date().toISOString(), scenarios: outScenarios, details }));
console.log("wrote", out, Object.keys(details).length, "customer details");
