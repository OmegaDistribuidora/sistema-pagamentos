import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../components/AuthProvider";
import { apiJson } from "../services/api";

function getBrazilDateKey(dateValue) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(dateValue));
}

function formatAuditDate(dateValue) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(dateValue));
}

function AuditDetailsModal({ log, onClose }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Auditoria</div>
            <h2>{log.summary}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            x
          </button>
        </div>

        <div className="summary-grid">
          <div className="summary-chip">
            <span className="metric-label">Data</span>
            <strong>{formatAuditDate(log.createdAt)}</strong>
          </div>
          <div className="summary-chip">
            <span className="metric-label">Acao</span>
            <strong>{log.action}</strong>
          </div>
          <div className="summary-chip">
            <span className="metric-label">Usuario</span>
            <strong>{log.actorDisplayName || log.actorUsername || "Sistema"}</strong>
          </div>
          <div className="summary-chip">
            <span className="metric-label">Entidade</span>
            <strong>{`${log.entityType}${log.entityId ? ` #${log.entityId}` : ""}`}</strong>
          </div>
        </div>

        <div className="modal-stack">
          <div>
            <div className="metric-label">Antes</div>
            <pre className="details-pre">{JSON.stringify(log.before, null, 2)}</pre>
          </div>
          <div>
            <div className="metric-label">Depois</div>
            <pre className="details-pre">{JSON.stringify(log.after, null, 2)}</pre>
          </div>
          <div>
            <div className="metric-label">Metadados</div>
            <pre className="details-pre">{JSON.stringify(log.metadata, null, 2)}</pre>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function AuditPage() {
  const { token } = useAuth();
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
  const [selectedLog, setSelectedLog] = useState(null);
  const [filter, setFilter] = useState("ALL");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  useEffect(() => {
    let active = true;
    apiJson("/audit", { token })
      .then((payload) => {
        if (active) {
          setLogs(payload.logs || []);
        }
      })
      .catch((requestError) => {
        if (active) {
          setError(requestError.message);
        }
      });

    return () => {
      active = false;
    };
  }, [token]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const matchesAction = filter === "ALL" ? true : log.action.includes(filter);
      const auditDateKey = getBrazilDateKey(log.createdAt);
      const matchesStart = startDate ? auditDateKey >= startDate : true;
      const matchesEnd = endDate ? auditDateKey <= endDate : true;
      return matchesAction && matchesStart && matchesEnd;
    });
  }, [endDate, filter, logs, startDate]);

  if (error) {
    return <div className="page-card error-text">{error}</div>;
  }

  return (
    <div className="page-stack">
      <section className="page-card compact-page-header">
        <div className="section-header audit-header">
          <div>
            <div className="eyebrow">Auditoria</div>
            <h1>Historico de acoes</h1>
            <p className="muted">Cada linha registra um evento executado por usuario ou pelo proprio sistema.</p>
          </div>
          <div className="audit-filters">
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="ALL">Todas as acoes</option>
              <option value="LOGIN">Logins</option>
              <option value="USER">Usuarios</option>
              <option value="MEI">Modulo MEI</option>
              <option value="PASSWORD">Senhas</option>
            </select>
            <button
              type="button"
              className="secondary-btn compact-btn"
              onClick={() => {
                setStartDate("");
                setEndDate("");
                setFilter("ALL");
              }}
            >
              Limpar filtros
            </button>
          </div>
        </div>
      </section>

      <section className="table-card">
        {filteredLogs.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Acao</th>
                  <th>Resumo</th>
                  <th>Usuario</th>
                  <th>Detalhes</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) => (
                  <tr key={log.id}>
                    <td>{formatAuditDate(log.createdAt)}</td>
                    <td>{log.action}</td>
                    <td>{log.summary}</td>
                    <td>{log.actorDisplayName || log.actorUsername || "Sistema"}</td>
                    <td>
                      <button type="button" className="secondary-btn compact-btn" onClick={() => setSelectedLog(log)}>
                        Ver mais
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">Nenhum evento encontrado para este filtro.</div>
        )}
      </section>

      {selectedLog ? <AuditDetailsModal log={selectedLog} onClose={() => setSelectedLog(null)} /> : null}
    </div>
  );
}
