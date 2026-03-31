import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../components/AuthProvider";
import { apiFormData, apiJson } from "../services/api";
import FilePicker from "../components/FilePicker";

function EmailIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path d="M4.5 5A2.5 2.5 0 0 0 2 7.5v9A2.5 2.5 0 0 0 4.5 19h15A2.5 2.5 0 0 0 22 16.5v-9A2.5 2.5 0 0 0 19.5 5h-15Zm0 2h15a.5.5 0 0 1 .31.89L12.62 13.6a1 1 0 0 1-1.24 0L4.19 7.89A.5.5 0 0 1 4.5 7Z" fill="currentColor" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path d="M16.86 3.49a2 2 0 0 1 2.83 0l.82.82a2 2 0 0 1 0 2.83l-9.9 9.9a1 1 0 0 1-.46.27l-4 1a1 1 0 0 1-1.22-1.22l1-4a1 1 0 0 1 .27-.46l9.9-9.9ZM15.44 5.6 7.8 13.24l-.56 2.25 2.25-.56 7.64-7.64-1.69-1.69Z" fill="currentColor" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path d="M9 3a1 1 0 0 0-.95.68L7.82 4H5a1 1 0 1 0 0 2h.35l.86 12.03A2 2 0 0 0 8.2 20h7.6a2 2 0 0 0 1.99-1.97L18.65 6H19a1 1 0 1 0 0-2h-2.82l-.23-.32A1 1 0 0 0 15 3H9Zm.44 3 .43 10a1 1 0 1 1-2 .08l-.43-10a1 1 0 0 1 2-.08Zm6.12 0a1 1 0 0 1 1 .96l-.43 10a1 1 0 1 1-2-.08l.43-10A1 1 0 0 1 15.56 6Z" fill="currentColor" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path d="M11 5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5Z" fill="currentColor" />
    </svg>
  );
}

function ModalShell({ title, eyebrow, onClose, children, compact = true }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className={`modal-card ${compact ? "modal-card-sm" : ""}`}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow">{eyebrow}</div>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            x
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function EmailModal({ record, saving, onClose, onSave }) {
  const [email, setEmail] = useState(record.email || "");

  function handleSubmit(event) {
    event.preventDefault();
    onSave(email);
  }

  return (
    <ModalShell title={record.vendorName} eyebrow="Email do vendedor" onClose={onClose}>
      <form className="modal-stack" onSubmit={handleSubmit}>
        <div className="edit-entry-grid">
          <label>
            Codigo do vendedor
            <input type="number" value={record.vendorCode} readOnly disabled />
          </label>
          <label>
            Supervisor
            <input type="number" value={record.supervisorCode} readOnly disabled />
          </label>
          <label className="edit-entry-grid-span-2">
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Deixe em branco para remover"
            />
          </label>
        </div>

        <div className="modal-actions">
          <button type="submit" className="primary-btn" disabled={saving}>
            {saving ? "Salvando..." : "Salvar email"}
          </button>
          <button type="button" className="secondary-btn" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function RecordModal({ record, saving, deleting, onClose, onSave, onDelete }) {
  const [form, setForm] = useState(() => ({
    supervisorCode: String(record?.supervisorCode ?? ""),
    vendorCode: String(record?.vendorCode ?? ""),
    vendorName: record?.vendorName ?? ""
  }));

  useEffect(() => {
    setForm({
      supervisorCode: String(record?.supervisorCode ?? ""),
      vendorCode: String(record?.vendorCode ?? ""),
      vendorName: record?.vendorName ?? ""
    });
  }, [record]);

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

  const isNew = !record;

  return (
    <ModalShell title={isNew ? "Novo vendedor" : form.vendorName || "Editar cadastro"} eyebrow="Cadastro global" onClose={onClose}>
      <form className="modal-stack" onSubmit={handleSubmit}>
        <div className="edit-entry-grid">
          <label>
            Codigo do vendedor
            <input
              type="number"
              value={form.vendorCode}
              onChange={(event) => updateField("vendorCode", event.target.value)}
              readOnly={!isNew}
              disabled={!isNew}
            />
          </label>
          <label>
            Supervisor
            <input type="number" value={form.supervisorCode} onChange={(event) => updateField("supervisorCode", event.target.value)} />
          </label>
          <label className="edit-entry-grid-span-2">
            Nome
            <input type="text" value={form.vendorName} onChange={(event) => updateField("vendorName", event.target.value)} />
          </label>
        </div>

        <div className="modal-actions">
          <button type="submit" className="primary-btn" disabled={saving || deleting}>
            {saving ? "Salvando..." : isNew ? "Adicionar" : "Salvar"}
          </button>
          {!isNew ? (
            <button type="button" className="danger-btn" onClick={onDelete} disabled={saving || deleting}>
              {deleting ? "Excluindo..." : "Excluir da base"}
            </button>
          ) : null}
          <button type="button" className="secondary-btn" onClick={onClose} disabled={saving || deleting}>
            Cancelar
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function ImportPreviewModal({ preview, loading, onClose, onConfirm }) {
  if (!preview) {
    return null;
  }

  return (
    <ModalShell title="Confirmar importacao da base" eyebrow="Preview da planilha" onClose={onClose} compact={false}>
      <div className="modal-stack">
        <div className="summary-grid">
          <article className="summary-chip">
            <span className="metric-label">Total enviado</span>
            <strong>{preview.summary.total}</strong>
          </article>
          <article className="summary-chip">
            <span className="metric-label">Novos</span>
            <strong>{preview.summary.created}</strong>
          </article>
          <article className="summary-chip">
            <span className="metric-label">Atualizados</span>
            <strong>{preview.summary.updated}</strong>
          </article>
          <article className="summary-chip">
            <span className="metric-label">Removidos</span>
            <strong>{preview.summary.removed}</strong>
          </article>
        </div>

        <div className="callout-card">
          <strong>Como deseja aplicar a planilha?</strong>
          <p className="muted">
            `Mesclar` adiciona novos vendedores e atualiza os existentes sem excluir os que ficaram fora da planilha. `Substituir`
            trata a planilha como a nova base completa e remove os ausentes.
          </p>
        </div>

        {preview.changesPreview?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Supervisor</th>
                  <th>Codigo</th>
                  <th>Nome</th>
                  <th>Campos</th>
                </tr>
              </thead>
              <tbody>
                {preview.changesPreview.map((item, index) => (
                  <tr key={`${item.type}-${item.vendorCode}-${index}`}>
                    <td>{item.type}</td>
                    <td>{item.supervisorCode}</td>
                    <td>{item.vendorCode}</td>
                    <td>{item.vendorName}</td>
                    <td>{item.fields.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="callout-card">
            <strong>Nenhuma alteracao detectada</strong>
            <p className="muted">A planilha possui exatamente a mesma base que ja esta cadastrada.</p>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="primary-btn" onClick={() => onConfirm("MERGE")} disabled={loading}>
            {loading ? "Aplicando..." : "Mesclar base"}
          </button>
          <button type="button" className="danger-btn" onClick={() => onConfirm("REPLACE")} disabled={loading}>
            {loading ? "Aplicando..." : "Substituir base"}
          </button>
          <button type="button" className="secondary-btn" onClick={onClose} disabled={loading}>
            Cancelar
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export default function VendorDirectoryPage() {
  const { token, user } = useAuth();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingRecord, setSavingRecord] = useState(false);
  const [deletingRecord, setDeletingRecord] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [emailRecord, setEmailRecord] = useState(null);
  const [editingRecord, setEditingRecord] = useState(null);
  const [creatingRecord, setCreatingRecord] = useState(false);

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

  async function handleSaveEmail(nextEmail) {
    if (!emailRecord) {
      return;
    }

    setSavingEmail(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson("/vendor-directory/email", {
        method: "POST",
        token,
        data: {
          vendorCode: emailRecord.vendorCode,
          email: String(nextEmail || "").trim()
        }
      });
      setNotice(payload.message);
      setEmailRecord(null);
      await loadRecords();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSavingEmail(false);
    }
  }

  async function handleImportPreview() {
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
      const payload = await apiFormData("/vendor-directory/import/preview", {
        method: "POST",
        token,
        data: formData
      });
      setImportPreview(payload);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setImporting(false);
    }
  }

  async function handleConfirmImport(mode) {
    if (!importPreview) {
      return;
    }

    setImporting(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson("/vendor-directory/import/confirm", {
        method: "POST",
        token,
        data: {
          previewToken: importPreview.previewToken,
          mode
        }
      });
      setNotice(
        `${payload.message} Total: ${payload.summary.total}. Novos: ${payload.summary.created}. Atualizados: ${payload.summary.updated}. Removidos: ${payload.summary.removed}.`
      );
      setImportPreview(null);
      setImportFile(null);
      await loadRecords();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setImporting(false);
    }
  }

  async function handleCreateRecord(form) {
    setSavingRecord(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson("/vendor-directory", {
        method: "POST",
        token,
        data: {
          supervisorCode: form.supervisorCode,
          vendorCode: form.vendorCode,
          vendorName: form.vendorName
        }
      });
      setNotice(payload.message);
      setCreatingRecord(false);
      await loadRecords();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSavingRecord(false);
    }
  }

  async function handleUpdateRecord(form) {
    if (!editingRecord) {
      return;
    }

    setSavingRecord(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson(`/vendor-directory/${editingRecord.vendorCode}`, {
        method: "PUT",
        token,
        data: {
          supervisorCode: form.supervisorCode,
          vendorName: form.vendorName
        }
      });
      setNotice(payload.message);
      setEditingRecord(null);
      await loadRecords();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSavingRecord(false);
    }
  }

  async function handleDeleteRecord(targetRecord = editingRecord) {
    if (!targetRecord) {
      return;
    }

    const confirmed = window.confirm(`Excluir ${targetRecord.vendorName} da base global?`);
    if (!confirmed) {
      return;
    }

    setDeletingRecord(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson(`/vendor-directory/${targetRecord.vendorCode}`, {
        method: "DELETE",
        token
      });
      setNotice(payload.message);
      if (editingRecord && targetRecord.vendorCode === editingRecord.vendorCode) {
        setEditingRecord(null);
      }
      await loadRecords();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setDeletingRecord(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="page-card page-card-compact">
        <div className="section-header">
          <div>
            <div className="eyebrow">Base Global</div>
            <h1>Base de Emails</h1>
          </div>
          <div className="muted small">{summaryLabel}</div>
        </div>
        <p className="muted">
          Esta base vale para todos os modulos de pagamento. Cada supervisor so visualiza e altera os vendedores do seu codigo.
        </p>
        {notice ? <p className="success-text">{notice}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      {user?.role === "ADMIN" ? (
        <section className="page-card page-card-compact">
          <div className="section-header">
            <div>
              <div className="eyebrow">Importacao</div>
              <h2>Base de vendedores por supervisor</h2>
            </div>
            <div className="toolbar-actions">
              <button type="button" className="secondary-btn compact-btn" onClick={() => setCreatingRecord(true)}>
                <PlusIcon />
                <span>Adicionar novo vendedor</span>
              </button>
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
            <button type="button" className="primary-btn compact-btn" onClick={handleImportPreview} disabled={importing}>
              {importing ? "Analisando..." : "Analisar importacao"}
            </button>
          </div>
        </section>
      ) : null}

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
                          className="icon-action-btn is-email"
                          onClick={() => setEmailRecord(record)}
                          title={record.email ? "Editar email" : "Adicionar email"}
                          aria-label={record.email ? "Editar email" : "Adicionar email"}
                        >
                          <EmailIcon />
                        </button>
                        {user?.role === "ADMIN" ? (
                          <>
                            <button
                              type="button"
                              className="icon-action-btn is-edit"
                              onClick={() => setEditingRecord(record)}
                              title="Editar cadastro"
                              aria-label="Editar cadastro"
                            >
                              <EditIcon />
                            </button>
                            <button
                              type="button"
                              className="icon-action-btn is-reject"
                              onClick={() => handleDeleteRecord(record)}
                              title="Excluir da base"
                              aria-label="Excluir da base"
                            >
                              <TrashIcon />
                            </button>
                          </>
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

      {emailRecord ? (
        <EmailModal record={emailRecord} saving={savingEmail} onClose={() => setEmailRecord(null)} onSave={handleSaveEmail} />
      ) : null}

      {editingRecord ? (
        <RecordModal
          record={editingRecord}
          saving={savingRecord}
          deleting={deletingRecord}
          onClose={() => setEditingRecord(null)}
          onSave={handleUpdateRecord}
          onDelete={() => handleDeleteRecord(editingRecord)}
        />
      ) : null}

      {creatingRecord ? (
        <RecordModal
          record={null}
          saving={savingRecord}
          deleting={false}
          onClose={() => setCreatingRecord(false)}
          onSave={handleCreateRecord}
          onDelete={() => undefined}
        />
      ) : null}

      {importPreview ? (
        <ImportPreviewModal
          preview={importPreview}
          loading={importing}
          onClose={() => setImportPreview(null)}
          onConfirm={handleConfirmImport}
        />
      ) : null}
    </div>
  );
}
