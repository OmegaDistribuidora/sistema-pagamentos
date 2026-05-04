import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../components/AuthProvider";
import { apiJson } from "../services/api";

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(Number(value || 0));
}

function formatGreetingDate() {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(new Date());
}

function formatSupervisorCodes(codes, legacyCode) {
  if (Array.isArray(codes) && codes.length) {
    return codes.join(", ");
  }

  return legacyCode || "-";
}

export default function DashboardPage() {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiJson("/dashboard", { token })
      .then((payload) => {
        if (active) {
          setData(payload);
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

  const greetingDate = useMemo(() => formatGreetingDate(), []);

  if (error) {
    return <div className="page-card error-text">{error}</div>;
  }

  if (!data) {
    return <div className="page-card">Carregando painel...</div>;
  }

  return (
    <div className="page-stack">
      <section className="page-card hero-card">
        <div className="eyebrow">Painel inicial</div>
        <h1>Bem vindo {data.user.displayName}, hoje e {greetingDate}</h1>
        <p className="muted">
          {data.user.role === "ADMIN"
            ? "Gerencie os lotes mensais, acompanhe as notas fiscais enviadas e audite as acoes do sistema."
            : "Consulte as comissoes do seu time, baixe os extratos do modulo MEI e envie as notas fiscais pendentes."}
        </p>
      </section>

      <section className="stats-grid">
        {data.user.role === "ADMIN" ? (
          <>
            <article className="stat-card">
              <span className="metric-label">Usuarios ativos</span>
              <strong>{data.stats.activeUsers}</strong>
            </article>
            <article className="stat-card">
              <span className="metric-label">Notas pendentes</span>
              <strong>{data.stats.pendingInvoices}</strong>
            </article>
            <article className="stat-card">
              <span className="metric-label">Ultimo mes importado</span>
              <strong>{data.stats.latestReferenceMonth || "-"}</strong>
            </article>
          </>
        ) : (
          <>
            <article className="stat-card">
              <span className="metric-label">Supervisores</span>
              <strong>{formatSupervisorCodes(data.stats.supervisorCodes, data.stats.supervisorCode)}</strong>
            </article>
            <article className="stat-card">
              <span className="metric-label">Vendedores no ultimo mes</span>
              <strong>{data.stats.vendorsInLatestMonth}</strong>
            </article>
            <article className="stat-card">
              <span className="metric-label">Total de comissao</span>
              <strong>{formatCurrency(data.stats.totalCommission)}</strong>
            </article>
          </>
        )}
      </section>

      <section className="cards-grid">
        {data.modules.map((module) => (
          <article key={module.key} className="module-card">
            <div>
              <div className="eyebrow">Modulo</div>
              <h2>{module.title}</h2>
              <p className="muted">{module.description}</p>
            </div>
            <Link to={module.path} className="secondary-btn compact-btn">
              Abrir
            </Link>
          </article>
        ))}
      </section>
    </div>
  );
}
