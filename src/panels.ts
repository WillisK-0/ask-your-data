import type { ReadOnlyDb } from "./db.js";

/** Refund requests derived from the sample data (void invoices in the last 120 days), with the policy rule that applies.
 *  Decisions live in memory for the life of the server: the database stays read-only. */
export type RefundRequest = {
  id: number; customer_id: number; customer: string; plan: string; amount: number; reason: string; requested: string;
  rule: string; can_approve: boolean; status: "pending" | "approved" | "rejected" | "escalated"; note?: string;
};

const REASONS = ["Duplicate charge", "Cancelled within 14 days", "Seats removed mid-cycle", "Renewal disputed"];

export function policyRule(reason: string, amount: number, plan: string): { rule: string; can_approve: boolean } {
  if (plan === "Enterprise") return { rule: "Enterprise refunds need account-manager approval and a signed change order.", can_approve: false };
  switch (reason) {
    case "Duplicate charge":
      return amount <= 600
        ? { rule: "Duplicate charge under $600: Tier 1 may approve. Refund in full within 5 business days.", can_approve: true }
        : { rule: "Duplicate charge over $600: needs Billing confirmation before approval.", can_approve: false };
    case "Cancelled within 14 days": return { rule: "Within 14 days of first charge: eligible for a full refund.", can_approve: true };
    case "Seats removed mid-cycle": return { rule: "Seat reductions are credited to the next invoice at the prorated rate, not refunded.", can_approve: false };
    default: return { rule: "Renewals are not refundable under the current policy.", can_approve: false };
  }
}

const decisions = new Map<number, { status: RefundRequest["status"]; note?: string }>();

export async function refundQueue(db: ReadOnlyDb): Promise<RefundRequest[]> {
  const rows = (await db.query(
    `SELECT i.id, i.customer_id, c.name AS customer, p.name AS plan, i.amount, substr(i.issued_at, 1, 10) AS requested
     FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN plans p ON p.id = c.plan_id
     WHERE i.status = 'void' AND i.issued_at >= date('2026-10-25', '-120 days') ORDER BY i.issued_at DESC LIMIT 12`,
  )).rows as { id: number; customer_id: number; customer: string; plan: string; amount: number; requested: string }[];
  return rows.map((r) => {
    const reason = REASONS[r.id % REASONS.length];
    const { rule, can_approve } = policyRule(reason, r.amount, r.plan);
    const d = decisions.get(r.id);
    return { ...r, amount: Math.round(r.amount * 100) / 100, reason, rule, can_approve, status: d?.status ?? "pending", note: d?.note };
  });
}

export function decideRefund(id: number, decision: "approved" | "rejected" | "escalated", note?: string) {
  decisions.set(id, { status: decision, note });
  return { id, status: decision, note, recorded_at: new Date().toISOString() };
}

/** Tickets created from the ticket form. In memory only: the sample database is opened read-only. */
const created: { id: number; customer_id: number; subject: string; category: string; priority: string; body: string; created_at: string }[] = [];
export function createTicket(t: { customer_id: number; subject: string; category: string; priority: string; body: string }) {
  const rec = { id: 5000 + created.length + 1, ...t, created_at: new Date().toISOString() };
  created.push(rec);
  return rec;
}
