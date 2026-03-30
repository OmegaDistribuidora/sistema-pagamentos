import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../components/AuthProvider";

export default function LoginPage() {
  const { login, isAuthenticated, user, ssoError, appConfig, configLoaded } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (isAuthenticated) {
    return <Navigate to={user?.role === "ADMIN" ? "/dashboard" : "/modules/mei"} replace />;
  }

  if (!configLoaded) {
    return <div className="screen-center">Carregando...</div>;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");

    try {
      setLoading(true);
      const payload = await login(username, password);
      navigate(payload?.user?.role === "ADMIN" ? "/dashboard" : "/modules/mei", { replace: true });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-stage-card">
        <div className="login-panel">
          <div className="eyebrow">Omega Distribuidora</div>
          <h1>{appConfig.systemName || "Sistema de Pagamentos"}</h1>
          <p className="muted">Central de pagamentos Ômega</p>

          {!appConfig.allowLocalLogin ? (
            <div className="callout-card">
              <strong>Login local indisponivel</strong>
              <p className="muted">
                Em producao, o acesso e feito somente via SSO. Entre primeiro no Ecossistema Omega e abra este sistema
                por la.
              </p>
              {ssoError ? <p className="error-text">{ssoError}</p> : null}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="form-stack">
              <label>
                Usuario
                <input value={username} onChange={(event) => setUsername(event.target.value)} required />
              </label>

              <label>
                Senha
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>

              {error ? <p className="error-text">{error}</p> : null}
              {!error && ssoError ? <p className="error-text">{ssoError}</p> : null}

              <button type="submit" className="primary-btn" disabled={loading}>
                {loading ? "Entrando..." : "Entrar"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
