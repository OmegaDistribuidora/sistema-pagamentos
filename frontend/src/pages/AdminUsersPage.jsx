import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../components/AuthProvider";
import { apiJson } from "../services/api";

function UserModal({ initialUser, onClose, onSave, saving, error }) {
  const isEditing = Boolean(initialUser?.id);
  const [form, setForm] = useState({
    displayName: initialUser?.displayName || "",
    username: initialUser?.username || "",
    password: "",
    role: initialUser?.role || "USER",
    supervisorCode: initialUser?.supervisorCode || "",
    active: initialUser?.active ?? true
  });

  useEffect(() => {
    if (form.role === "ADMIN" && form.supervisorCode) {
      setForm((current) => ({ ...current, supervisorCode: "" }));
    }
  }, [form.role, form.supervisorCode]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    await onSave({
      displayName: form.displayName,
      username: form.username,
      password: form.password,
      role: form.role,
      supervisorCode: form.role === "USER" ? Number(form.supervisorCode || 0) || null : null,
      active: Boolean(form.active)
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal-card modal-card-sm" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Usuarios</div>
            <h2>{isEditing ? "Editar usuario" : "Novo usuario"}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            x
          </button>
        </div>

        <form className="form-stack" onSubmit={handleSubmit}>
          <label>
            Nome
            <input value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} required />
          </label>

          <label>
            Login
            <input value={form.username} onChange={(event) => updateField("username", event.target.value)} required />
          </label>

          <label>
            Senha {isEditing ? "(opcional)" : ""}
            <input
              type="password"
              value={form.password}
              onChange={(event) => updateField("password", event.target.value)}
              minLength={isEditing ? 0 : 6}
              required={!isEditing}
            />
          </label>

          <label>
            Perfil
            <select value={form.role} onChange={(event) => updateField("role", event.target.value)}>
              <option value="USER">User</option>
              <option value="ADMIN">Administrador</option>
            </select>
          </label>

          {form.role === "USER" ? (
            <label>
              Codigo de supervisor
              <input
                type="number"
                value={form.supervisorCode}
                onChange={(event) => updateField("supervisorCode", event.target.value)}
                required
              />
            </label>
          ) : null}

          <label className="inline-check">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(event) => updateField("active", event.target.checked)}
            />
            <span>Usuario ativo</span>
          </label>

          {error ? <p className="error-text">{error}</p> : null}

          <div className="modal-actions">
            <button type="submit" className="primary-btn" disabled={saving}>
              {saving ? "Salvando..." : "Salvar"}
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

export default function AdminUsersPage() {
  const { token, user: authUser, updateSession } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modalUser, setModalUser] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  async function loadUsers() {
    setLoading(true);
    setError("");

    try {
      const payload = await apiJson("/users", { token });
      setUsers(payload.users || []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, [token]);

  const orderedUsers = useMemo(
    () =>
      [...users].sort((a, b) => {
        if (a.role !== b.role) {
          return a.role.localeCompare(b.role);
        }
        return a.displayName.localeCompare(b.displayName);
      }),
    [users]
  );

  async function handleSave(payload) {
    setSaving(true);
    setSaveError("");
    setNotice("");

    try {
      const response = modalUser?.id
        ? await apiJson(`/users/${modalUser.id}`, {
            method: "PUT",
            token,
            data: payload
          })
        : await apiJson("/users", {
            method: "POST",
            token,
            data: payload
          });

      if (response?.sessionToken && response?.user?.id === authUser?.id) {
        updateSession(response.sessionToken, response.user);
      }

      setModalUser(null);
      setNotice(modalUser?.id ? "Usuario atualizado com sucesso." : "Usuario criado com sucesso.");
      await loadUsers();
    } catch (requestError) {
      setSaveError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(targetUser) {
    const confirmed = window.confirm(`Excluir o usuario ${targetUser.displayName}?`);
    if (!confirmed) {
      return;
    }

    setNotice("");
    setError("");

    try {
      await apiJson(`/users/${targetUser.id}`, {
        method: "DELETE",
        token
      });
      setNotice("Usuario excluido com sucesso.");
      await loadUsers();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  return (
    <div className="page-stack">
      <section className="page-card">
        <div className="section-header">
          <div>
            <div className="eyebrow">Administracao</div>
            <h1>Usuarios</h1>
            <p className="muted">Somente administradores podem criar, editar ou remover usuarios do sistema.</p>
          </div>
          <button type="button" className="primary-btn" onClick={() => setModalUser({})}>
            Novo usuario
          </button>
        </div>
        {notice ? <p className="success-text">{notice}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="table-card">
        {loading ? (
          <div>Carregando usuarios...</div>
        ) : orderedUsers.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Login</th>
                  <th>Perfil</th>
                  <th>Supervisor</th>
                  <th>Status</th>
                  <th>Acoes</th>
                </tr>
              </thead>
              <tbody>
                {orderedUsers.map((user) => (
                  <tr key={user.id}>
                    <td>{user.displayName}</td>
                    <td>{user.username}</td>
                    <td>{user.role === "ADMIN" ? "Administrador" : "User"}</td>
                    <td>{user.supervisorCode || "-"}</td>
                    <td>{user.active ? "Ativo" : "Inativo"}</td>
                    <td>
                      <div className="inline-actions">
                        <button type="button" className="secondary-btn compact-btn" onClick={() => setModalUser(user)}>
                          Editar
                        </button>
                        {authUser?.id !== user.id ? (
                          <button type="button" className="danger-btn compact-btn" onClick={() => handleDelete(user)}>
                            Excluir
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">Nenhum usuario cadastrado.</div>
        )}
      </section>

      {modalUser !== null ? (
        <UserModal
          initialUser={modalUser}
          onClose={() => {
            setModalUser(null);
            setSaveError("");
          }}
          onSave={handleSave}
          saving={saving}
          error={saveError}
        />
      ) : null}
    </div>
  );
}
