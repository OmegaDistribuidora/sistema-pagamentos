import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../components/AuthProvider";
import FilePicker from "../components/FilePicker";
import { apiFormData, apiJson, downloadFile } from "../services/api";

const EMPTY_FILTERS = {
  search: "",
  coordinatorCode: "",
  region: "",
  supervisorCode: "",
  personType: "",
  month: "",
  year: "",
  event: "",
  paymentMethod: "",
  supplier: ""
};
const PAGE_SIZE = 200;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function emptyRecord(user) {
  const today = todayIso();
  return {
    coordinatorCode: "",
    region: "",
    supervisorCode: "",
    supervisorName: "",
    personCode: "",
    personName: "",
    personType: "",
    delinquencyAmount: 0,
    meiDiscountAmount: 0,
    amountToPay: "",
    month: new Date().getMonth() + 1,
    year: new Date().getFullYear(),
    event: "Comissão",
    supplier: "",
    paymentMethod: "Alelo",
    releaseBy: "",
    sourceUser: user?.username || "",
    registeredAt: today,
    paidAt: today,
    competenceAt: today,
    notes: ""
  };
}

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "-";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return `${day}/${month}/${year}`;
}

function buildQuery(filters) {
  const query = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (String(value || "").trim()) query.set(key, value);
  });
  return query.toString();
}

function FilterSelect({ label, field, value, options, onChange, renderOption }) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(field, event.target.value)}>
        <option value="">Todos</option>
        {(options || []).map((option) => (
          <option key={option} value={option}>
            {renderOption ? renderOption(option) : option}
          </option>
        ))}
      </select>
    </label>
  );
}

function RecordModal({ initialRecord, user, events, paymentMethods, months, saving, error, onClose, onSave }) {
  const editing = Boolean(initialRecord?.id);
  const [form, setForm] = useState(() => (initialRecord ? { ...initialRecord } : emptyRecord(user)));
  const total =
    Number(form.amountToPay || 0) +
    Number(form.meiDiscountAmount || 0) +
    Number(form.delinquencyAmount || 0);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit(event) {
    event.preventDefault();
    onSave({
      ...form,
      coordinatorCode: Number(form.coordinatorCode),
      supervisorCode: Number(form.supervisorCode),
      personCode: Number(form.personCode),
      delinquencyAmount: Number(form.delinquencyAmount || 0),
      meiDiscountAmount: Number(form.meiDiscountAmount || 0),
      amountToPay: Number(form.amountToPay),
      month: Number(form.month),
      year: Number(form.year)
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal-card payment-history-record-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Historico de Pagamentos</div>
            <h2>{editing ? "Editar registro" : "Novo registro"}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>x</button>
        </div>

        <form className="form-stack" onSubmit={submit}>
          <div className="payment-history-form-grid">
            <label>CodCoord<input type="number" min="0" value={form.coordinatorCode} onChange={(event) => update("coordinatorCode", event.target.value)} required /></label>
            <label>Regiao<input value={form.region} onChange={(event) => update("region", event.target.value)} required /></label>
            <label>CodSuperv<input type="number" min="0" value={form.supervisorCode} onChange={(event) => update("supervisorCode", event.target.value)} required /></label>
            <label>Supervisor<input value={form.supervisorName} onChange={(event) => update("supervisorName", event.target.value)} required /></label>
            <label>CodRca<input type="number" min="0" value={form.personCode} onChange={(event) => update("personCode", event.target.value)} required /></label>
            <label className="span-2">NomeRca<input value={form.personName} onChange={(event) => update("personName", event.target.value)} required /></label>
            <label>Tipo<input value={form.personType} onChange={(event) => update("personType", event.target.value)} required /></label>

            <label>Inadim./Vale<input type="number" step="0.01" value={form.delinquencyAmount} onChange={(event) => update("delinquencyAmount", event.target.value)} /></label>
            <label>Desc. MEI<input type="number" step="0.01" value={form.meiDiscountAmount} onChange={(event) => update("meiDiscountAmount", event.target.value)} /></label>
            <label>Total<input type="text" value={formatCurrency(total)} readOnly /></label>
            <label>Total a Pagar<input type="number" step="0.01" value={form.amountToPay} onChange={(event) => update("amountToPay", event.target.value)} required /></label>

            <label>Mes<select value={form.month} onChange={(event) => update("month", event.target.value)}>{months.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select></label>
            <label>Ano<input type="number" min="2000" max="2100" value={form.year} onChange={(event) => update("year", event.target.value)} required /></label>
            <label>Evento<select value={form.event} onChange={(event) => update("event", event.target.value)}>{events.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label>Forma de pagamento<select value={form.paymentMethod} onChange={(event) => update("paymentMethod", event.target.value)}>{paymentMethods.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>

            <label className="span-2">Fornecedor<input value={form.supplier} onChange={(event) => update("supplier", event.target.value)} required /></label>
            <label>Liberacao<input value={form.releaseBy} onChange={(event) => update("releaseBy", event.target.value)} required /></label>
            <label>Usuario<input value={form.sourceUser} onChange={(event) => update("sourceUser", event.target.value)} /></label>

            <label>Dt. Registro<input type="date" value={String(form.registeredAt || "").slice(0, 10)} onChange={(event) => update("registeredAt", event.target.value)} required /></label>
            <label>Dt. Pagamento<input type="date" value={String(form.paidAt || "").slice(0, 10)} onChange={(event) => update("paidAt", event.target.value)} required /></label>
            <label>Mes Competencia<input type="date" value={String(form.competenceAt || "").slice(0, 10)} onChange={(event) => update("competenceAt", event.target.value)} required /></label>
            <label className="span-3">Observacao<textarea rows={3} value={form.notes || ""} onChange={(event) => update("notes", event.target.value)} /></label>
          </div>

          {error ? <p className="error-text">{error}</p> : null}
          <div className="modal-actions">
            <button type="submit" className="primary-btn" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</button>
            <button type="button" className="secondary-btn" onClick={onClose}>Cancelar</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ImportModal({ file, preview, saving, error, issues, onFile, onPreview, onConfirm, onClose }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Historico de Pagamentos</div>
            <h2>Importar planilha</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>x</button>
        </div>

        {!preview ? (
          <div className="form-stack">
            <p className="muted">Use o modelo padrao. A importacao valida eventos, formas de pagamento, totais, campos obrigatorios e registros repetidos.</p>
            <FilePicker file={file} accept=".xlsx,.xls" disabled={saving} buttonLabel="Selecionar planilha" placeholder="Nenhum arquivo selecionado" onChange={onFile} />
            {error ? <p className="error-text">{error}</p> : null}
            {issues?.length ? (
              <div className="import-issues">
                {issues.map((issue) => <div key={`${issue.row}-${issue.message}`}><strong>Linha {issue.row}:</strong> {issue.message}</div>)}
              </div>
            ) : null}
            <div className="modal-actions">
              <button type="button" className="primary-btn" onClick={onPreview} disabled={!file || saving}>{saving ? "Validando..." : "Validar e visualizar"}</button>
              <button type="button" className="secondary-btn" onClick={onClose}>Cancelar</button>
            </div>
          </div>
        ) : (
          <div className="form-stack">
            <div className="stats-grid">
              <article className="stat-card"><span className="metric-label">Linhas recebidas</span><strong>{preview.totalRows}</strong></article>
              <article className="stat-card"><span className="metric-label">Novos registros</span><strong>{preview.createdCount}</strong></article>
              <article className="stat-card"><span className="metric-label">Alteracoes</span><strong>{preview.updatedCount}</strong></article>
              <article className="stat-card"><span className="metric-label">Repetidos no arquivo</span><strong>{preview.duplicateUploadCount}</strong></article>
            </div>

            {preview.updatedCount || preview.duplicateUploadCount ? (
              <p className="warning-text">
                Atencao: a confirmacao alterara registros existentes. Quando o arquivo repete evento, codigo e periodo,
                prevalece a ultima linha. O evento Consideracao sempre gera um novo registro.
              </p>
            ) : <p className="success-text">Nenhum conflito encontrado. Todos os registros serao adicionados.</p>}

            {preview.conflicts?.length ? (
              <div className="table-wrap import-preview-table">
                <table>
                  <thead><tr><th>Codigo</th><th>Nome</th><th>Evento</th><th>Periodo</th><th>Registros atuais</th></tr></thead>
                  <tbody>
                    {preview.conflicts.map((item) => (
                      <tr key={`${item.id}-${item.event}-${item.month}-${item.year}`}>
                        <td>{item.personCode}</td><td>{item.personName}</td><td>{item.event}</td>
                        <td>{String(item.month).padStart(2, "0")}/{item.year}</td><td>{item.existingCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {error ? <p className="error-text">{error}</p> : null}
            <div className="modal-actions">
              <button type="button" className="primary-btn" onClick={onConfirm} disabled={saving}>{saving ? "Importando..." : preview.updatedCount || preview.duplicateUploadCount ? "Confirmar alteracoes" : "Confirmar importacao"}</button>
              <button type="button" className="secondary-btn" onClick={onClose}>Cancelar</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default function PaymentHistoryPage() {
  const { token, user } = useAuth();
  const [data, setData] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modalRecord, setModalRecord] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importError, setImportError] = useState("");
  const [importIssues, setImportIssues] = useState([]);
  const [page, setPage] = useState(1);

  const query = useMemo(() => buildQuery(filters), [filters]);

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const payload = await apiJson(`/modules/payment-history${query ? `?${query}` : ""}`, { token });
      setData(payload);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setPage(1);
    const timer = window.setTimeout(loadData, filters.search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [token, query]);

  function updateFilter(field, value) {
    setFilters((current) => ({ ...current, [field]: value }));
  }

  async function saveRecord(record, confirmConflict = false) {
    setSaving(true);
    setSaveError("");
    try {
      const editing = Boolean(modalRecord?.id);
      const payload = await apiJson(
        editing ? `/modules/payment-history/records/${modalRecord.id}` : "/modules/payment-history/records",
        {
          method: editing ? "PUT" : "POST",
          token,
          data: { record, confirmConflict }
        }
      );
      setModalRecord(null);
      setNotice(payload.operation === "created" ? "Registro adicionado com sucesso." : "Registro alterado com sucesso.");
      await loadData();
    } catch (requestError) {
      if (requestError.status === 409 && requestError.payload?.conflict && !confirmConflict) {
        const confirmed = window.confirm(`${requestError.message}\n\nDeseja continuar?`);
        if (confirmed) {
          setSaving(false);
          return saveRecord(record, true);
        }
      }
      setSaveError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteRecord(record) {
    if (!window.confirm(`Remover o registro de ${record.personName} (${record.event} - ${record.monthLabel}/${record.year})?`)) return;
    setError("");
    setNotice("");
    try {
      await apiJson(`/modules/payment-history/records/${record.id}`, { method: "DELETE", token });
      setNotice("Registro removido com sucesso.");
      await loadData();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function previewImport() {
    if (!importFile) return;
    setSaving(true);
    setImportError("");
    setImportIssues([]);
    try {
      const formData = new FormData();
      formData.append("file", importFile);
      const payload = await apiFormData("/modules/payment-history/import/preview", { token, data: formData });
      setImportPreview(payload);
    } catch (requestError) {
      setImportError(requestError.message);
      setImportIssues(requestError.payload?.issues || []);
    } finally {
      setSaving(false);
    }
  }

  async function confirmImport() {
    setSaving(true);
    setImportError("");
    try {
      const payload = await apiJson("/modules/payment-history/import/confirm", {
        method: "POST",
        token,
        data: { token: importPreview.token }
      });
      setNotice(`${payload.message} ${payload.createdCount} novo(s) e ${payload.updatedCount} alterado(s).`);
      closeImport();
      await loadData();
    } catch (requestError) {
      setImportError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  function closeImport() {
    setImportOpen(false);
    setImportFile(null);
    setImportPreview(null);
    setImportError("");
    setImportIssues([]);
  }

  const records = data?.records || [];
  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageRecords = records.slice(pageStart, pageStart + PAGE_SIZE);
  const totalVisible = records.reduce((sum, record) => sum + Number(record.totalAmount || 0), 0);
  const canManage = data?.canManage === true;
  const options = data?.filterOptions || {};

  return (
    <div className="page-stack payment-history-page">
      <section className="page-card compact-page-header">
        <div className="section-header">
          <div>
            <div className="eyebrow">Modulo</div>
            <h1>Historico de Pagamentos</h1>
            <p className="muted">Consulte e mantenha o registro consolidado de pagamentos.</p>
          </div>
          <div className="toolbar-actions">
            <button type="button" className="secondary-btn compact-btn" onClick={() => downloadFile("/modules/payment-history/template", { token, fileName: "modelo-historico-pagamentos.xlsx" })}>Baixar modelo</button>
            <button type="button" className="secondary-btn compact-btn" onClick={() => downloadFile(`/modules/payment-history/export${query ? `?${query}` : ""}`, { token })}>Exportar visiveis</button>
            {canManage ? <button type="button" className="secondary-btn compact-btn" onClick={() => setImportOpen(true)}>Importar</button> : null}
            {canManage ? <button type="button" className="primary-btn compact-btn" onClick={() => setModalRecord({})}>Novo registro</button> : null}
          </div>
        </div>
        {notice ? <p className="success-text">{notice}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="page-card payment-history-filter-card">
        <div className="payment-history-search-row">
          <label className="filter-field search-field">
            <span>Busca</span>
            <input value={filters.search} onChange={(event) => updateFilter("search", event.target.value)} placeholder="Nome, codigo, supervisor, fornecedor, observacao..." />
          </label>
          <button type="button" className="secondary-btn compact-btn" onClick={() => setFilters(EMPTY_FILTERS)}>Limpar filtros</button>
        </div>
        <div className="payment-history-filters">
          <FilterSelect label="Coordenador" field="coordinatorCode" value={filters.coordinatorCode} options={options.coordinatorCodes} onChange={updateFilter} />
          <FilterSelect label="Regiao" field="region" value={filters.region} options={options.regions} onChange={updateFilter} />
          <FilterSelect label="Supervisor" field="supervisorCode" value={filters.supervisorCode} options={options.supervisorCodes} onChange={updateFilter} />
          <FilterSelect label="Tipo" field="personType" value={filters.personType} options={options.personTypes} onChange={updateFilter} />
          <FilterSelect label="Mes" field="month" value={filters.month} options={options.months} onChange={updateFilter} renderOption={(month) => data?.months?.[Number(month) - 1] || month} />
          <FilterSelect label="Ano" field="year" value={filters.year} options={options.years} onChange={updateFilter} />
          <FilterSelect label="Evento" field="event" value={filters.event} options={options.events} onChange={updateFilter} />
          <FilterSelect label="Pagamento" field="paymentMethod" value={filters.paymentMethod} options={options.paymentMethods} onChange={updateFilter} />
          <FilterSelect label="Fornecedor" field="supplier" value={filters.supplier} options={options.suppliers} onChange={updateFilter} />
        </div>
      </section>

      <section className="stats-grid payment-history-stats">
        <article className="stat-card"><span className="metric-label">Registros visiveis</span><strong>{data?.total || 0}</strong></article>
        <article className="stat-card"><span className="metric-label">Total visivel</span><strong>{formatCurrency(totalVisible)}</strong></article>
        <article className="stat-card"><span className="metric-label">Acesso</span><strong>{canManage ? "Edicao" : "Somente leitura"}</strong></article>
      </section>

      <section className="table-card payment-history-table-card">
        {loading ? <div>Carregando historico...</div> : records.length ? (
          <>
            <div className="payment-history-pagination">
              <span>
                Exibindo {pageStart + 1}-{Math.min(pageStart + PAGE_SIZE, records.length)} de {records.length}
              </span>
              <div className="inline-actions">
                <button type="button" className="secondary-btn compact-btn" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Anterior</button>
                <span>Pagina {currentPage} de {totalPages}</span>
                <button type="button" className="secondary-btn compact-btn" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>Proxima</button>
              </div>
            </div>
            <div className="table-wrap payment-history-table-wrap">
              <table className="payment-history-table">
              <thead><tr>
                <th>CodCoord</th><th>Regiao</th><th>CodSuperv</th><th>Supervisor</th><th>CodRca</th><th>NomeRca</th><th>Tipo</th>
                <th>Inadim./Vale</th><th>Desc. MEI</th><th>Total</th><th>Total a Pagar</th><th>Mes</th><th>Ano</th><th>Evento</th>
                <th>Fornecedor</th><th>Forma de Pag.</th><th>Liberacao</th><th>Usuario</th><th>Dt. Registro</th><th>Dt. Pagamento</th>
                <th>Mes Competencia</th><th>Obs</th>{canManage ? <th>Acoes</th> : null}
              </tr></thead>
              <tbody>
                {pageRecords.map((record) => (
                  <tr key={record.id}>
                    <td>{record.coordinatorCode}</td><td>{record.region}</td><td>{record.supervisorCode}</td><td>{record.supervisorName}</td>
                    <td>{record.personCode}</td><td>{record.personName}</td><td>{record.personType}</td>
                    <td>{formatCurrency(record.delinquencyAmount)}</td><td>{formatCurrency(record.meiDiscountAmount)}</td>
                    <td><strong>{formatCurrency(record.totalAmount)}</strong></td><td>{formatCurrency(record.amountToPay)}</td>
                    <td>{record.monthLabel}</td><td>{record.year}</td><td>{record.event}</td><td>{record.supplier}</td>
                    <td>{record.paymentMethod}</td><td>{record.releaseBy}</td><td>{record.sourceUser || "-"}</td>
                    <td>{formatDate(record.registeredAt)}</td><td>{formatDate(record.paidAt)}</td><td>{formatDate(record.competenceAt)}</td>
                    <td>{record.notes || "-"}</td>
                    {canManage ? <td><div className="inline-actions">
                      <button type="button" className="secondary-btn compact-btn" onClick={() => setModalRecord(record)}>Editar</button>
                      <button type="button" className="danger-btn compact-btn" onClick={() => deleteRecord(record)}>Excluir</button>
                    </div></td> : null}
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </>
        ) : <div className="muted">Nenhum registro encontrado para os filtros selecionados.</div>}
      </section>

      {modalRecord ? (
        <RecordModal
          initialRecord={modalRecord.id ? modalRecord : null}
          user={user}
          events={data?.events || []}
          paymentMethods={data?.paymentMethods || []}
          months={data?.months || []}
          saving={saving}
          error={saveError}
          onClose={() => { setModalRecord(null); setSaveError(""); }}
          onSave={saveRecord}
        />
      ) : null}

      {importOpen ? (
        <ImportModal
          file={importFile}
          preview={importPreview}
          saving={saving}
          error={importError}
          issues={importIssues}
          onFile={(file) => { setImportFile(file); setImportPreview(null); setImportError(""); setImportIssues([]); }}
          onPreview={previewImport}
          onConfirm={confirmImport}
          onClose={closeImport}
        />
      ) : null}
    </div>
  );
}
