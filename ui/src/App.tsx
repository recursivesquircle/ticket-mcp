import { useEffect, useMemo, useState } from "react";
import {
  getTicket,
  listTickets,
  moveTicket,
  updateTicket,
} from "./api";
import { TicketStatusValues } from "@ticket/shared/schema";

type TicketSummary = {
  id: string;
  title: string;
  status: string;
  area: string;
  epic: string;
  path: string;
  updated_at?: string;
  issues?: string[];
};

type TicketDetail = {
  path: string;
  frontmatter: Record<string, any>;
  body: string;
  issues?: string[];
};

const STATUS_COLUMNS = [
  "pending",
  "in_progress",
  "blocked",
  "awaiting_human_test",
  "done",
  "archived",
];

const statusLabels: Record<string, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  blocked: "Blocked",
  awaiting_human_test: "Awaiting Test",
  done: "Done",
  archived: "Archived",
};

export default function App() {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [filters, setFilters] = useState({
    text: "",
    status: [] as string[],
    area: "",
    epic: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);

  useEffect(() => {
    loadTickets();
  }, [filters.text, filters.area, filters.epic, filters.status]);

  async function loadTickets() {
    setLoading(true);
    setError(null);
    try {
      const payload = await listTickets(buildFilters());
      setTickets(payload?.tickets ?? []);
    } catch (err: any) {
      setError(err.message ?? "Failed to load tickets");
    } finally {
      setLoading(false);
    }
  }

  async function openTicket(summary: TicketSummary) {
    setSaving(false);
    const payload = await getTicket({ path: summary.path });
    if (payload?.error) {
      setError(payload.error);
      return;
    }
    setSelected(payload as TicketDetail);
  }

  async function saveTicket(update: { status: string; area: string; epic: string }) {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const currentStatus = selected.frontmatter.status;
      let targetPath = selected.path;
      if (update.status !== currentStatus) {
        const move = await moveTicket({
          path: selected.path,
          to_status: update.status,
        });
        if (move?.error) throw new Error(move.error);
        targetPath = move.path ?? targetPath;
      }

      const result = await updateTicket({
        path: targetPath,
        patch: { area: update.area, epic: update.epic },
      });
      if (result?.error) throw new Error(result.error);

      const refreshed = await getTicket({ path: targetPath });
      setSelected(refreshed as TicketDetail);
      await loadTickets();
    } catch (err: any) {
      setError(err.message ?? "Failed to save ticket");
    } finally {
      setSaving(false);
    }
  }

  async function handleMoveTicket(ticket: TicketSummary, toStatus: string) {
    if (ticket.status === toStatus) return;
    setError(null);

    const previous = tickets;
    setTickets((current) =>
      current.map((entry) =>
        entry.path === ticket.path ? { ...entry, status: toStatus } : entry,
      ),
    );

    try {
      const result = await moveTicket({ path: ticket.path, to_status: toStatus });
      if (result?.error) throw new Error(result.error);
      await loadTickets();
    } catch (err: any) {
      setTickets(previous);
      setError(err.message ?? "Failed to move ticket");
    }
  }

  function buildFilters() {
    return {
      text: filters.text || undefined,
      status: filters.status.length ? filters.status : undefined,
      area: filters.area || undefined,
      epic: filters.epic || undefined,
    };
  }

  const areas = useMemo(() => {
    const values = new Set(tickets.map((ticket) => ticket.area).filter(Boolean));
    return Array.from(values).sort();
  }, [tickets]);

  const epics = useMemo(() => {
    const values = new Set(
      tickets.map((ticket) => ticket.epic || "none").filter(Boolean),
    );
    return Array.from(values).sort();
  }, [tickets]);

  const grouped = useMemo(() => {
    const map: Record<string, TicketSummary[]> = {};
    for (const status of STATUS_COLUMNS) map[status] = [];
    for (const ticket of tickets) {
      const key = map[ticket.status] ? ticket.status : "pending";
      map[key].push(ticket);
    }
    return map;
  }, [tickets]);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Ticket Tracker</h1>
          <p>Hybrid file-backed tracker with MCP control plane.</p>
        </div>
        <button className="ghost" onClick={loadTickets} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </header>

      <section className="filters">
        <input
          className="search"
          placeholder="Search by id, title, intent..."
          value={filters.text}
          onChange={(event) =>
            setFilters((prev) => ({ ...prev, text: event.target.value }))
          }
        />
        <select
          value={filters.area}
          onChange={(event) =>
            setFilters((prev) => ({ ...prev, area: event.target.value }))
          }
        >
          <option value="">All areas</option>
          {areas.map((area) => (
            <option key={area} value={area}>
              {area}
            </option>
          ))}
        </select>
        <select
          value={filters.epic}
          onChange={(event) =>
            setFilters((prev) => ({ ...prev, epic: event.target.value }))
          }
        >
          <option value="">All epics</option>
          {epics.map((epic) => (
            <option key={epic} value={epic}>
              {epic}
            </option>
          ))}
        </select>
        <div className="status-filter">
          {STATUS_COLUMNS.map((status) => (
            <label key={status}>
              <input
                type="checkbox"
                checked={filters.status.includes(status)}
                onChange={(event) => {
                  setFilters((prev) => {
                    const next = new Set(prev.status);
                    if (event.target.checked) next.add(status);
                    else next.delete(status);
                    return { ...prev, status: Array.from(next) };
                  });
                }}
              />
              {statusLabels[status]}
            </label>
          ))}
        </div>
      </section>

      {error && <div className="error">{error}</div>}

      <main className="board">
        {STATUS_COLUMNS.map((status) => (
          <section
            key={status}
            className={`column ${dragOver === status ? "drag-over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(status);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(null);
              const payload = event.dataTransfer.getData("application/json");
              if (!payload) return;
              try {
                const dropped = JSON.parse(payload) as TicketSummary;
                handleMoveTicket(dropped, status);
              } catch {
                setError("Failed to read dragged ticket");
              }
            }}
          >
            <header>
              <h2>{statusLabels[status]}</h2>
              <span>{grouped[status]?.length ?? 0}</span>
            </header>
            <div className="cards">
              {grouped[status]?.map((ticket) => (
                <button
                  key={ticket.path}
                  className={`card ${ticket.issues?.length ? "warn" : ""}`}
                  onClick={() => openTicket(ticket)}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(
                      "application/json",
                      JSON.stringify(ticket),
                    );
                  }}
                >
                  <div className="card-title">
                    <span>{ticket.id}</span>
                    {ticket.issues?.length ? (
                      <span className="badge">Schema</span>
                    ) : null}
                  </div>
                  <h3>{ticket.title}</h3>
                  <div className="meta">
                    <span>{ticket.area || "(no area)"}</span>
                    <span>{ticket.epic || "none"}</span>
                  </div>
                  <div className="time">{ticket.updated_at ?? ""}</div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </main>

      {selected && (
        <aside className="drawer">
          <header>
            <div>
              <h2>{selected.frontmatter.title}</h2>
              <p>{selected.frontmatter.id}</p>
            </div>
            <button className="ghost" onClick={() => setSelected(null)}>
              Close
            </button>
          </header>

          <div className="drawer-grid">
            <label>
              Status
              <select
                value={selected.frontmatter.status}
                onChange={(event) =>
                  setSelected((prev) =>
                    prev
                      ? {
                        ...prev,
                        frontmatter: {
                          ...prev.frontmatter,
                          status: event.target.value,
                        },
                      }
                      : prev,
                  )
                }
              >
                {TicketStatusValues.map((status: string) => (
                  <option key={status} value={status}>
                    {statusLabels[status] ?? status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Area
              <input
                value={selected.frontmatter.area ?? ""}
                onChange={(event) =>
                  setSelected((prev) =>
                    prev
                      ? {
                        ...prev,
                        frontmatter: {
                          ...prev.frontmatter,
                          area: event.target.value,
                        },
                      }
                      : prev,
                  )
                }
              />
            </label>
            <label>
              Epic
              <input
                value={selected.frontmatter.epic ?? "none"}
                onChange={(event) =>
                  setSelected((prev) =>
                    prev
                      ? {
                        ...prev,
                        frontmatter: {
                          ...prev.frontmatter,
                          epic: event.target.value,
                        },
                      }
                      : prev,
                  )
                }
              />
            </label>
            <label>
              Path
              <input value={selected.path} readOnly />
            </label>
            <label>
              Updated
              <input value={selected.frontmatter.updated_at ?? ""} readOnly />
            </label>
          </div>

          {selected.issues?.length ? (
            <div className="issues">
              <h3>Validation Issues</h3>
              <ul>
                {selected.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="body">
            <h3>Body</h3>
            <pre>{selected.body}</pre>
          </div>

          <div className="actions">
            <button
              className="primary"
              onClick={() =>
                saveTicket({
                  status: selected.frontmatter.status,
                  area: selected.frontmatter.area ?? "",
                  epic: selected.frontmatter.epic ?? "",
                })
              }
              disabled={saving}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
