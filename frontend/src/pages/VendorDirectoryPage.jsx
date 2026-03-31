import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../components/AuthProvider";
import { apiFormData, apiJson } from "../services/api";
import FilePicker from "../components/FilePicker";

function VendorDirectoryEditModal({ record, saving, deleting, onClose, onSave, onDelete }) {
  const [form, setForm] = useState(() => ({
    supervisorCode: String(record.supervisorCode ?? ""),
    vendorName: record.vendorName ?? ""
  }));

  function updateField(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value
    }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    onSave(form);
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal-card modal-card-sm" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Edicao da base global</div>
            <h2>{record.vendorName}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            x
          </button>
        </div>

        <form className="modal-stack" onSubmit={handleSubmit}>
          <div className="edit-entry-grid">
            <label>
              Codigo do vendedor
              <input type="number" value={record.vendorCode} readOnly disabled />
            </label>
            <label>
              Supervisor
              <input
                type="number"
                value={form.supervisorCode}
                onChange={(event) => updateField("supervisorCode", event.target.value)}
              />
            </label>
            <label className="edit-entry-grid-span-2">
              Nome
              <input type="text" value={form.vendorName} onChange={(event) => updateField("vendorName", event.target.value)} />
            </label>
          </div>

          <div className="modal-actions">
            <button type="submit" className="primary-btn" disabled={saving || deleting}>
              {saving ? "Salvando..." : "Salvar"}
            </button>
            <button type="button" className="danger-btn" onClick={onDelete} disabled={saving || deleting}>
              {deleting ? "Excluindo..." : "Excluir da base"}
            </button>
            <button type="button" className="secondary-btn" onClick={onClose} disabled={saving || deleting}>
              Cancelar
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default function VendorDirectoryPage() {
  const { token, user } = useAuth();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [editingRecord, setEditingRecord] = useState(null);
  const [updatingRecord, setUpdatingRecord] = useState(false);
  const [deletingRecord, setDeletingRecord] = useState(false);
  const [form, setForm] = useState({
    vendorCode: "",
    email: ""
  });

  const summaryLabel = useMemo(() => `${records.length} vendedor(es) na base acessivel.`, [records]);

  async function loadRecords() {
    setLoading(true);
    setError("");

    try {
      const payload = await apiJson("/vendor-directory", { token });
      setRecords(payload.records || []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRecords().catch((requestError) => setError(requestError.message));
  }, [token]);

  async function handleSaveEmail() {
    if (!form.vendorCode) {
      setError("Informe o codigo do vendedor.");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson("/vendor-directory/email", {
        method: "POST",
        token,
        data: {
          vendorCode: form.vendorCode,
          email: form.email.trim()
        }
      });
      setNotice(payload.message);
      setForm({ vendorCode: "", email: "" });
      await loadRecords();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleImport() {
    if (!importFile) {
      setError("Selecione a planilha da base de vendedores.");
      return;
    }

    setImporting(true);
    setError("");
    setNotice("");

    try {
      const formData = new FormData();
      formData.append("file", importFile);
      const payload = await apiFormData("/vendor-directory/import", {
        method: "POST",
        token,
        data: formData
      });
      setNotice(
        `${payload.message} Total: ${payload.summary.total}. Novos: ${payload.summary.created}. Atualizados: ${payload.summary.updated}. Removidos: ${payload.summary.removed}.`
      );
      setImportFile(null);
      await loadRecords();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setImporting(false);
    }
  }

  async function handleSaveRecord(formData) {
    if (!editingRecord) {
      return;
    }

    setUpdatingRecord(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson(`/vendor-directory/${editingRecord.vendorCode}`, {
        method: "PUT",
        token,
        data: {
          supervisorCode: formData.supervisorCode,
          vendorName: formData.vendorName
        }
      });
      setNotice(payload.message);
      setEditingRecord(null);
      await loadRecords();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setUpdatingRecord(false);
    }
  }

  async function handleDeleteRecord() {
    if (!editingRecord) {
      return;
    }

    const confirmed = window.confirm(`Excluir ${editingRecord.vendorName} da base global?`);
    if (!confirmed) {
      return;
    }

    setDeletingRecord(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson(`/vendor-directory/${editingRecord.vendorCode}`, {
        method: "DELETE",
        token
      });
      setNotice(payload.message);
      if (String(form.vendorCode) === String(editingRecord.vendorCode)) {
        setForm({ vendorCode: "", email: "" });
      }
      setEditingRecord(null);
      await loadRecords();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setDeletingRecord(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="page-card">
        <div className="section-header">
          <div>
            <div className="eyebrow">Base Global</div>
            <h1>Base de Emails</h1>
            <p className="muted">
              Esta base vale para todos os modulos de pagamento. Cada supervisor so visualiza e altera os vendedores do seu codigo.
            </p>
          </div>
        </div>
        <div className="muted small">{summaryLabel}</div>
        {notice ? <p className="success-text">{notice}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      {user?.role === "ADMIN" ? (
        <section className="page-card">
          <div className="section-header">
            <div>
              <div className="eyebrow">Importacao</div>
              <h2>Base de vendedores por supervisor</h2>
              <p className="muted">
                Exporte a planilha do SharePoint em `.xlsx` e importe aqui. Colunas esperadas: `CODSUP`, `COD RCA` e `RCA`.
              </p>
            </div>
          </div>

          <div className="toolbar-actions">
            <FilePicker
              accept=".xlsx"
              file={importFile}
              buttonLabel="Selecionar planilha"
              placeholder="Nenhum arquivo selecionado"
              onChange={setImportFile}
            />
            <button type="button" className="primary-btn" onClick={handleImport} disabled={importing}>
              {importing ? "Importando..." : "Importar base"}
            </button>
          </div>
        </section>
      ) : null}

      <section className="page-card">
        <div className="section-header">
          <div>
            <div className="eyebrow">Edicao</div>
            <h2>Emails dos vendedores</h2>
          </div>
        </div>

        <div className="email-base-grid">
          <label>
            Codigo do vendedor
            <input
              type="number"
              value={form.vendorCode}
              onChange={(event) => setForm((current) => ({ ...current, vendorCode: event.target.value }))}
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={form.email}
              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
              placeholder="Deixe em branco para remover"
            />
          </label>
          <div className="email-base-actions">
            <button type="button" className="primary-btn" onClick={handleSaveEmail} disabled={saving}>
              {saving ? "Salvando..." : "Salvar email"}
            </button>
          </div>
        </div>
      </section>

      <section className="table-card">
        <div className="section-header">
          <div>
            <div className="eyebrow">Consulta</div>
            <h2>Vendedores da sua base</h2>
          </div>
        </div>

        {loading ? (
          <div>Carregando base de vendedores...</div>
        ) : records.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {user?.role === "ADMIN" ? <th>Supervisor</th> : null}
                  <th>Codigo vendedor</th>
                  <th>Nome</th>
                  <th>Email</th>
                  <th>Acoes</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.vendorCode}>
                    {user?.role === "ADMIN" ? <td>{record.supervisorCode}</td> : null}
                    <td>{record.vendorCode}</td>
                    <td>{record.vendorName}</td>
                    <td>{record.email || <span className="muted">Nao cadastrado</span>}</td>
                    <td>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="secondary-btn compact-btn"
                          onClick={() => setForm({ vendorCode: String(record.vendorCode), email: record.email || "" })}
                        >
                          Email
                        </button>
                        {user?.role === "ADMIN" ? (
                          <button
                            type="button"
                            className="secondary-btn compact-btn"
                            onClick={() => setEditingRecord(record)}
                          >
                            Cadastro
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
          <div className="empty-state">Nenhum vendedor disponivel na base geral.</div>
        )}
      </section>

      {editingRecord ? (
        <VendorDirectoryEditModal
          record={editingRecord}
          saving={updatingRecord}
          deleting={deletingRecord}
          onClose={() => setEditingRecord(null)}
          onSave={handleSaveRecord}
          onDelete={handleDeleteRecord}
        />
      ) : null}
    </div>
  );
}
