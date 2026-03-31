import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { apiJson } from "../services/api";
import omegaLogo from "../assets/logo.png";

function PasswordModal({ onClose, onSubmit, saving, error, success, isAdmin, users, currentUserId }) {
  const [form, setForm] = useState({
    targetUserId: currentUserId || "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: ""
  });

  useEffect(() => {
    setForm((current) => ({
      ...current,
      targetUserId: currentUserId || ""
    }));
  }, [currentUserId]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    await onSubmit(form, () =>
      setForm((current) => ({
        ...current,
        currentPassword: "",
        newPassword: "",
        confirmPassword: ""
      }))
    );
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal-card modal-card-sm" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Conta</div>
            <h2>Trocar senha</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            x
          </button>
        </div>

        <form className="form-stack" onSubmit={handleSubmit}>
          {isAdmin ? (
            <label>
              Usuario
              <select
                value={form.targetUserId}
                onChange={(event) => updateField("targetUserId", Number(event.target.value))}
              >
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName} ({user.username})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Senha atual
              <input
                type="password"
                value={form.currentPassword}
                onChange={(event) => updateField("currentPassword", event.target.value)}
                required
              />
            </label>
          )}

          <label>
            Nova senha
            <input
              type="password"
              value={form.newPassword}
              onChange={(event) => updateField("newPassword", event.target.value)}
              minLength={6}
              required
            />
          </label>

          <label>
            Confirmar nova senha
            <input
              type="password"
              value={form.confirmPassword}
              onChange={(event) => updateField("confirmPassword", event.target.value)}
              minLength={6}
              required
            />
          </label>

          {error ? <p className="error-text">{error}</p> : null}
          {success ? <p className="success-text">{success}</p> : null}

          <div className="modal-actions">
            <button type="submit" className="primary-btn" disabled={saving}>
              {saving ? "Salvando..." : "Salvar senha"}
            </button>
            <button type="button" className="secondary-btn" onClick={onClose}>
              Cancelar
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default function AppLayout() {
  const { token, user, logout } = useAuth();
  const navigate = useNavigate();
  const [adminUsers, setAdminUsers] = useState([]);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");

  useEffect(() => {
    if (!token || user?.role !== "ADMIN") {
      setAdminUsers([]);
      return;
    }

    let active = true;
    apiJson("/users", { token })
      .then((payload) => {
        if (active) {
          setAdminUsers(payload.users || []);
        }
      })
      .catch(() => {
        if (active) {
          setAdminUsers([]);
        }
      });

    return () => {
      active = false;
    };
  }, [token, user?.role]);

  const navigationItems = useMemo(() => {
    if (user?.role === "ADMIN") {
      return [
        { to: "/dashboard", label: "Inicio", adminOnly: true },
        { to: "/modules/mei", label: "Pagamentos MEI", adminOnly: false },
        { to: "/directory/vendors", label: "Base de Emails", adminOnly: false },
        { to: "/admin/users", label: "Usuarios", adminOnly: true },
        { to: "/admin/audit", label: "Auditoria", adminOnly: true }
      ];
    }

    return [
      { to: "/modules/mei", label: "Pagamentos MEI", adminOnly: false },
      { to: "/directory/vendors", label: "Base de Emails", adminOnly: false }
    ];
  }, [user?.role]);

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  async function handleChangePassword(form, resetForm) {
    setPasswordSaving(true);
    setPasswordError("");
    setPasswordSuccess("");

    try {
      const payload = await apiJson("/auth/change-password", {
        method: "POST",
        token,
        data: {
          targetUserId: form.targetUserId ? Number(form.targetUserId) : undefined,
          currentPassword: form.currentPassword,
          newPassword: form.newPassword,
          confirmPassword: form.confirmPassword
        }
      });

      setPasswordSuccess(payload.message || "Senha alterada com sucesso.");
      resetForm();
    } catch (error) {
      setPasswordError(error.message);
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-card">
          <NavLink to="/" className="brand-link">
            <img src={omegaLogo} alt="Omega" className="brand-logo-image" />
            <span>
              <strong>Sistema de Pagamentos</strong>
              <small>Omega Distribuidora</small>
            </span>
          </NavLink>
        </div>

        <nav className="nav-stack">
          {navigationItems.map((item) => (
            <NavLink key={item.to} to={item.to} className="nav-link" end={item.to === "/" || item.to === "/dashboard"}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div>
            <strong>{user?.displayName}</strong>
            <div className="muted small">
              {user?.role === "ADMIN" ? "Administrador" : `Supervisor ${user?.supervisorCode || "-"}`}
            </div>
          </div>
          <button type="button" className="secondary-btn ghost-btn" onClick={() => setPasswordModalOpen(true)}>
            Trocar senha
          </button>
          <button type="button" className="primary-btn ghost-btn" onClick={handleLogout}>
            Sair
          </button>
        </div>
      </aside>

      <main className="content">
        <Outlet />
      </main>

      {passwordModalOpen ? (
        <PasswordModal
          onClose={() => setPasswordModalOpen(false)}
          onSubmit={handleChangePassword}
          saving={passwordSaving}
          error={passwordError}
          success={passwordSuccess}
          isAdmin={user?.role === "ADMIN"}
          users={adminUsers}
          currentUserId={user?.id}
        />
      ) : null}
    </div>
  );
}
