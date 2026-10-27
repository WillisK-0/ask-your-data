import type { ReadOnlyDb } from "./db.js";

/** One customer with totals, tickets and invoices. Shared by the MCP tool and the demo-data generator. */
export async function customerDetail(db: ReadOnlyDb, id: number) {
  const c = (await db.query(
    `SELECT c.id, c.name, c.industry, c.region, p.name AS plan, c.seats, c.created_at, c.churned_at
     FROM customers c LEFT JOIN plans p ON p.id = c.plan_id WHERE c.id = ${Number(id)}`,
  )).rows[0] as Record<string, unknown> | undefined;
  if (!c) throw new Error(`No customer with id ${id}`);
  const tickets = (await db.query(
    `SELECT t.id, t.subject, t.category, t.priority, t.status, substr(t.opened_at,1,10) AS opened, substr(t.resolved_at,1,10) AS resolved, t.csat, a.name AS agent
     FROM tickets t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.customer_id = ${Number(id)} ORDER BY t.opened_at DESC LIMIT 200`,
  )).rows as Record<string, unknown>[];
  const invoices = (await db.query(
    `SELECT id, amount, status, substr(issued_at,1,10) AS issued, substr(due_at,1,10) AS due, substr(paid_at,1,10) AS paid
     FROM invoices WHERE customer_id = ${Number(id)} ORDER BY issued_at DESC LIMIT 200`,
  )).rows as Record<string, unknown>[];
  const sum = (rows: Record<string, unknown>[], pred: (r: Record<string, unknown>) => boolean) =>
    Math.round(rows.filter(pred).reduce((s, r) => s + Number(r.amount ?? 0), 0) * 100) / 100;
  const csat = tickets.map((t) => t.csat).filter((v): v is number => typeof v === "number");
  return {
    customer: c,
    totals: {
      paid: sum(invoices, (r) => r.status === "paid"),
      outstanding: sum(invoices, (r) => r.status === "open" || r.status === "overdue"),
      overdue: invoices.filter((r) => r.status === "overdue").length,
      open_tickets: tickets.filter((t) => t.status === "open" || t.status === "pending" || t.status === "escalated").length,
      avg_csat: csat.length ? Math.round((csat.reduce((a, b) => a + b, 0) / csat.length) * 10) / 10 : null,
    },
    tickets,
    invoices,
  };
}
