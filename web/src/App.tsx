import { useEffect, useRef, useState } from "react";

type Role = "user" | "assistant";
interface Turn { role: Role; text: string; }
interface TraceItem { tool: string; input: Record<string, unknown>; }

const EXAMPLES = [
  "Which customers have two or more overdue invoices and an open urgent ticket?",
  "Average hours to first response by priority, last 90 days. Are we meeting SLA?",
  "Can a Tier 1 agent approve a $450 duplicate-charge refund?",
  "Monthly recurring revenue by plan, and how much did we lose to churn this year?",
];

export function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [turns, busy]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const next: Turn[] = [...turns, { role: "user", text: q }];
    setTurns(next);
    setInput("");
    setBusy(true);
    setError(null);
    setTrace([]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.map((t) => ({ role: t.role, content: t.text })) }),
      });
      const data = (await res.json()) as { text?: string; trace?: TraceItem[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `Request failed (${res.status})`);
      setTurns([...next, { role: "assistant", text: data.text ?? "" }]);
      setTrace(data.trace ?? []);
    } catch (err) {
      setError((err as Error).message);
      setTurns(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="top">
        <span className="brand">ask-your-data</span>
        <span className="sub">Claude answering from a live SQLite database and a docs folder. Read-only. Every query shown on the right.</span>
      </header>

      <main className="chat">
        {turns.length === 0 && (
          <div className="empty">
            <p>Ask a question a support manager would ask. The database has 420 customers, 2,600 tickets, and 4,878 invoices.</p>
            <ul>
              {EXAMPLES.map((e) => (
                <li key={e}><button onClick={() => ask(e)}>{e}</button></li>
              ))}
            </ul>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`turn ${t.role}`}>{t.text}</div>
        ))}
        {busy && <div className="turn assistant thinking">Querying…</div>}
        {error && <div className="turn error">{error}</div>}
        <div ref={bottom} />
      </main>

      <form className="ask" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about customers, tickets, invoices, or policy"
          disabled={busy}
          autoFocus
        />
        <button type="submit" disabled={busy || !input.trim()}>Ask</button>
      </form>

      <aside className="trace">
        <div className="trace-head">What Claude ran</div>
        {trace.length === 0 ? (
          <div className="trace-empty">Tool calls for the last answer appear here.</div>
        ) : (
          trace.map((t, i) => (
            <div key={i} className="call">
              <div className="call-name">{i + 1}. {t.tool}</div>
              {Object.keys(t.input).length > 0 && (
                <pre>{typeof t.input.sql === "string" ? t.input.sql : JSON.stringify(t.input, null, 2)}</pre>
              )}
            </div>
          ))
        )}
      </aside>
    </div>
  );
}
