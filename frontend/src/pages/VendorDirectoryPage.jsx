import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../components/AuthProvider";
import { apiFormData, apiJson } from "../services/api";
import FilePicker from "../components/FilePicker";

export default function VendorDirectoryPage() {
  const { token, user } = useAuth();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFile, setImportFile] = useState(null);
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
                      <button
                        type="button"
                        className="secondary-btn compact-btn"
                        onClick={() => setForm({ vendorCode: String(record.vendorCode), email: record.email || "" })}
                      >
                        Editar
                      </button>
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
    </div>
  );
}
