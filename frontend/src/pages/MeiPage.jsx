import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../components/AuthProvider";
import { apiFormData, apiJson, downloadFile } from "../services/api";
import FilePicker from "../components/FilePicker";

const EMAIL_FEATURE_ENABLED = false;

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(Number(value || 0));
}

function formatMonthLabel(referenceMonth) {
  if (!referenceMonth) {
    return "-";
  }

  const [year, month] = String(referenceMonth).split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    month: "long",
    year: "numeric"
  }).format(new Date(year, month - 1, 1));
}

function buildExtractDownloadFileName(entry) {
  const normalizedName = String(entry?.vendorName || "Vendedor")
    .normalize("NFKD")
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-");

  return `Extrato-${entry.vendorCode}-${normalizedName || "Vendedor"}.pdf`;
}

function buildInvoiceDownloadFileName(entry, originalFileName) {
  const normalizedName = String(entry?.vendorName || "Vendedor")
    .normalize("NFKD")
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-");

  const extensionMatch = String(originalFileName || "").match(/\.[a-z0-9]+$/i);
  const extension = extensionMatch?.[0] || ".pdf";
  return `Nota-${entry.vendorCode}-${normalizedName || "Vendedor"}${extension}`;
}

function previewFileName(fileName, maxLength = 34) {
  const value = String(fileName || "").trim();
  if (!value || value.length <= maxLength) {
    return value;
  }

  const extensionMatch = value.match(/\.[a-z0-9]+$/i);
  const extension = extensionMatch?.[0] || "";
  const baseName = extension ? value.slice(0, -extension.length) : value;
  const visibleLength = Math.max(10, maxLength - extension.length - 3);
  return `${baseName.slice(0, visibleLength)}...${extension}`;
}

function getReferenceMonthRange(referenceMonth) {
  const [year, month] = String(referenceMonth || "").split("-").map(Number);
  if (!year || !month) {
    return {
      start: "",
      end: ""
    };
  }

  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);

  const format = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  return {
    start: format(startDate),
    end: format(endDate)
  };
}

function ExtractDownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path d="M7 3.5A2.5 2.5 0 0 1 9.5 1h4.38c.66 0 1.3.26 1.77.73l2.62 2.62c.47.47.73 1.1.73 1.77V10a1 1 0 1 1-2 0V7h-2.5A1.5 1.5 0 0 1 13 5.5V3H9.5a.5.5 0 0 0-.5.5v8a1 1 0 1 1-2 0v-8Z" fill="currentColor" />
      <path d="M12 10a1 1 0 0 1 1 1v5.59l1.3-1.29a1 1 0 1 1 1.4 1.41l-3 3a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.41l1.3 1.29V11a1 1 0 0 1 1-1Z" fill="currentColor" />
      <path d="M5 19a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v1.5A1.5 1.5 0 0 1 18.5 23h-13A1.5 1.5 0 0 1 4 21.5V20a1 1 0 0 1 1-1Z" fill="currentColor" />
    </svg>
  );
}

function InvoiceDownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path d="M6 2.5A1.5 1.5 0 0 1 7.5 1h6.88c.4 0 .78.16 1.06.44l2.12 2.12c.28.28.44.66.44 1.06V9a1 1 0 1 1-2 0V5h-2.5A1.5 1.5 0 0 1 12 3.5V3H8v8a1 1 0 1 1-2 0v-8.5Z" fill="currentColor" />
      <path d="M8 7.5A1.5 1.5 0 0 1 9.5 6h8A1.5 1.5 0 0 1 19 7.5v10a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 8 17.5v-10Z" fill="currentColor" opacity="0.75" />
      <path d="M12 10a1 1 0 0 1 1 1v3.59l.8-.79a1 1 0 1 1 1.4 1.41l-2.5 2.5a1 1 0 0 1-1.4 0l-2.5-2.5a1 1 0 1 1 1.4-1.41l.8.79V11a1 1 0 0 1 1-1Z" fill="currentColor" />
      <path d="M8 21a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1Z" fill="currentColor" />
    </svg>
  );
}

function ApproveIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path d="M9.55 16.6 5.7 12.75a1 1 0 1 1 1.4-1.42l2.45 2.46 7.35-7.39a1 1 0 0 1 1.42 1.4l-8.06 8.1a1 1 0 0 1-1.41 0Z" fill="currentColor" />
    </svg>
  );
}

function RejectIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path d="M7.4 6 12 10.6 16.6 6A1 1 0 0 1 18 7.4L13.4 12l4.6 4.6a1 1 0 1 1-1.4 1.4L12 13.4 7.4 18A1 1 0 1 1 6 16.6L10.6 12 6 7.4A1 1 0 0 1 7.4 6Z" fill="currentColor" />
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

function EmailSendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path d="M4.5 5A2.5 2.5 0 0 0 2 7.5v9A2.5 2.5 0 0 0 4.5 19H12a1 1 0 1 0 0-2H4.5a.5.5 0 0 1-.5-.5v-6.56l7.43 4.46a1 1 0 0 0 1.03 0L19 10.49V12a1 1 0 1 0 2 0V7.5A2.5 2.5 0 0 0 18.5 5h-14Zm14.2 2L12 11.03 5.3 7h13.4Z" fill="currentColor" />
      <path d="M18.8 14.2a1 1 0 0 1 1.4 0l2.5 2.5a1 1 0 0 1 0 1.4l-2.5 2.5a1 1 0 1 1-1.4-1.4l.8-.8H16a1 1 0 1 1 0-2h3.6l-.8-.8a1 1 0 0 1 0-1.4Z" fill="currentColor" />
    </svg>
  );
}

function statusTone(status) {
  if (status === "APPROVED") return "is-approved";
  if (status === "REJECTED") return "is-rejected";
  if (status === "PENDING") return "is-pending";
  return "is-not-sent";
}

function statusLabel(status) {
  if (status === "APPROVED") return "Aprovado";
  if (status === "REJECTED") return "Recusado";
  if (status === "PENDING") return "Pendente";
  return "Nao enviada";
}

function PreviewTable({ preview }) {
  if (!preview) {
    return null;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Supervisor</th>
            <th>Vendedor</th>
            <th>Nome</th>
            <th>Comissao a receber</th>
          </tr>
        </thead>
        <tbody>
          {preview.previewRows.map((row) => (
            <tr key={row.vendorCode}>
              <td>{row.supervisorCode}</td>
              <td>{row.vendorCode}</td>
              <td>{row.vendorName}</td>
              <td>{formatCurrency(row.commissionToReceive)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function diffTypeLabel(type) {
  if (type === "CREATE") return "Novo";
  if (type === "UPDATE") return "Alterado";
  if (type === "REMOVE") return "Removido";
  return "Sem mudanca";
}

function diffTypeTone(type) {
  if (type === "CREATE") return "is-create";
  if (type === "UPDATE") return "is-update";
  if (type === "REMOVE") return "is-remove";
  return "is-unchanged";
}

function ChangePreviewList({ preview }) {
  if (!preview?.existingBatch || !preview.changeSummary) {
    return null;
  }

  const { changed, created, removed, unchanged } = preview.changeSummary;

  return (
    <div className="page-stack">
      <div className="summary-grid">
        <article className="summary-chip">
          <span className="metric-label">Alterados</span>
          <strong>{changed}</strong>
        </article>
        <article className="summary-chip">
          <span className="metric-label">Novos</span>
          <strong>{created}</strong>
        </article>
        <article className="summary-chip">
          <span className="metric-label">Removidos</span>
          <strong>{removed}</strong>
        </article>
        <article className="summary-chip">
          <span className="metric-label">Sem mudanca</span>
          <strong>{unchanged}</strong>
        </article>
      </div>

      {preview.changesPreview?.length ? (
        <div className="callout-card">
          <strong>Alteracoes detectadas</strong>
          <div className="modal-stack">
            {preview.changesPreview.map((item, index) => (
              <div key={`${item.type}-${item.vendorCode}-${index}`} className="muted small">
                <strong>{item.type}</strong> | {item.vendorCode} | {item.vendorName} | {item.fields.join(", ")}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="callout-card">
          <strong>Nenhuma alteracao encontrada</strong>
          <p className="muted">A nova planilha possui os mesmos vendedores e valores do lote ja importado.</p>
        </div>
      )}
    </div>
  );
}

function ImportPreviewModal({ preview, loading, onClose, onConfirm }) {
  if (!preview) {
    return null;
  }

  const summary = preview.changeSummary || null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={loading ? undefined : onClose}>
      <section className="modal-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Preview da importacao</div>
            <h2>{preview.existingBatch ? "Diferencas encontradas para este periodo" : "Conferir planilha do periodo"}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} disabled={loading}>
            x
          </button>
        </div>

        <div className="modal-stack">
          <div className="callout-card">
            <strong>{preview.originalFileName}</strong>
            <p className="muted">
              {preview.totalRows} linha(s) validada(s).
              {preview.existingBatch ? " Ao confirmar, o lote atual sera substituido pela nova planilha." : ""}
            </p>
          </div>

          {summary ? (
            <>
              <div className="summary-grid">
                <article className="summary-chip">
                  <span className="metric-label">Novos</span>
                  <strong>{summary.created}</strong>
                </article>
                <article className="summary-chip">
                  <span className="metric-label">Alterados</span>
                  <strong>{summary.changed}</strong>
                </article>
                <article className="summary-chip">
                  <span className="metric-label">Removidos</span>
                  <strong>{summary.removed}</strong>
                </article>
                <article className="summary-chip">
                  <span className="metric-label">Sem mudanca</span>
                  <strong>{summary.unchanged}</strong>
                </article>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Supervisor</th>
                      <th>Vendedor</th>
                      <th>Nome</th>
                      <th>Campos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.diffRows?.map((item, index) => (
                      <tr key={`${item.type}-${item.vendorCode}-${index}`} className={`diff-row ${diffTypeTone(item.type)}`}>
                        <td>
                          <span className={`status-pill ${diffTypeTone(item.type)}`}>{diffTypeLabel(item.type)}</span>
                        </td>
                        <td>{item.supervisorCode}</td>
                        <td>{item.vendorCode}</td>
                        <td>{item.vendorName}</td>
                        <td>{item.fields.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              <div className="callout-card">
                <strong>Novo lote</strong>
                <p className="muted">Ainda nao existe planilha para este periodo. Confira a previa antes de confirmar.</p>
              </div>
              <PreviewTable preview={preview} />
            </>
          )}

          <div className="modal-actions">
            <button type="button" className="primary-btn" onClick={onConfirm} disabled={loading}>
              {loading ? "Confirmando..." : "Confirmar importacao"}
            </button>
            <button type="button" className="secondary-btn" onClick={onClose} disabled={loading}>
              Cancelar
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function EditEntryModal({ entry, saving, onClose, onSave }) {
  const isCreating = !entry.id;
  const [form, setForm] = useState(() => ({
    periodStart: entry.periodStart ?? "",
    periodEnd: entry.periodEnd ?? "",
    supervisorCode: String(entry.supervisorCode ?? ""),
    vendorCode: String(entry.vendorCode ?? ""),
    vendorName: entry.vendorName ?? "",
    grossSales: String(entry.grossSales ?? 0),
    returnsAmount: String(entry.returnsAmount ?? 0),
    netSales: String(entry.netSales ?? 0),
    advanceAmount: String(entry.advanceAmount ?? 0),
    delinquencyAmount: String(entry.delinquencyAmount ?? 0),
    grossCommission: String(entry.grossCommission ?? 0),
    averageCommissionPercent: String(entry.averageCommissionPercent ?? 0),
    reversalAmount: String(entry.reversalAmount ?? 0),
    totalCommissionToInvoice: String(entry.totalCommissionToInvoice ?? 0),
    commissionToReceive: String(entry.commissionToReceive ?? 0)
  }));

  function updateField(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value
    }));
  }

  function submit(event) {
    event.preventDefault();
    onSave(form);
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal-card modal-card-sm" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">{isCreating ? "Novo vendedor manual" : "Edicao manual"}</div>
            <h2>{isCreating ? "Adicionar registro ao periodo" : entry.vendorName}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            x
          </button>
        </div>

        <form className="modal-stack" onSubmit={submit}>
          <div className="edit-entry-grid">
            <label>
              Data inicio
              <input type="date" value={form.periodStart} onChange={(event) => updateField("periodStart", event.target.value)} />
            </label>
            <label>
              Data fim
              <input type="date" value={form.periodEnd} onChange={(event) => updateField("periodEnd", event.target.value)} />
            </label>
            <label>
              Supervisor
              <input type="number" value={form.supervisorCode} onChange={(event) => updateField("supervisorCode", event.target.value)} />
            </label>
            <label>
              Codigo vendedor
              <input type="number" value={form.vendorCode} onChange={(event) => updateField("vendorCode", event.target.value)} />
            </label>
            <label className="edit-entry-grid-span-2">
              Nome
              <input type="text" value={form.vendorName} onChange={(event) => updateField("vendorName", event.target.value)} />
            </label>
            <label>
              Venda bruta
              <input type="number" step="0.01" value={form.grossSales} onChange={(event) => updateField("grossSales", event.target.value)} />
            </label>
            <label>
              Devolucao
              <input type="number" step="0.01" value={form.returnsAmount} onChange={(event) => updateField("returnsAmount", event.target.value)} />
            </label>
            <label>
              Venda liquida
              <input type="number" step="0.01" value={form.netSales} onChange={(event) => updateField("netSales", event.target.value)} />
            </label>
            <label>
              Adiantamento
              <input type="number" step="0.01" value={form.advanceAmount} onChange={(event) => updateField("advanceAmount", event.target.value)} />
            </label>
            <label>
              Inadimplencia
              <input type="number" step="0.01" value={form.delinquencyAmount} onChange={(event) => updateField("delinquencyAmount", event.target.value)} />
            </label>
            <label>
              Comissao bruta
              <input type="number" step="0.01" value={form.grossCommission} onChange={(event) => updateField("grossCommission", event.target.value)} />
            </label>
            <label>
              % comissao media
              <input
                type="number"
                step="0.0001"
                value={form.averageCommissionPercent}
                onChange={(event) => updateField("averageCommissionPercent", event.target.value)}
              />
            </label>
            <label>
              Estorno
              <input type="number" step="0.01" value={form.reversalAmount} onChange={(event) => updateField("reversalAmount", event.target.value)} />
            </label>
            <label>
              Total mes a faturar
              <input
                type="number"
                step="0.01"
                value={form.totalCommissionToInvoice}
                onChange={(event) => updateField("totalCommissionToInvoice", event.target.value)}
              />
            </label>
            <label>
              Comissao a receber
              <input
                type="number"
                step="0.01"
                value={form.commissionToReceive}
                onChange={(event) => updateField("commissionToReceive", event.target.value)}
              />
            </label>
          </div>

          <div className="modal-actions">
            <button type="submit" className="primary-btn" disabled={saving}>
              {saving ? "Salvando..." : isCreating ? "Adicionar" : "Salvar"}
            </button>
            <button type="button" className="secondary-btn" onClick={onClose} disabled={saving}>
              Cancelar
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function BulkEmailModal({ preview, sending, onClose, onConfirm }) {
  if (!preview) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Envio em lote</div>
            <h2>Extratos MEI por email</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            x
          </button>
        </div>

        <div className="modal-stack">
          <div className="summary-grid">
            <article className="summary-chip">
              <span className="metric-label">Vao receber</span>
              <strong>{preview.summary.willSend}</strong>
            </article>
            <article className="summary-chip">
              <span className="metric-label">Nao vao receber</span>
              <strong>{preview.summary.skipped}</strong>
            </article>
            <article className="summary-chip">
              <span className="metric-label">Assunto</span>
              <strong>{preview.subject}</strong>
            </article>
          </div>

          <div className="callout-card">
            <strong>Corpo da mensagem</strong>
            <p className="muted">
              Bom dia prestador de serviço.
              <br />
              Segue seu extrato MEI em PDF. Qualquer dúvida entrar em contato com seu supervisor.
              <br />
              <br />
              Este é um email automático. Não responda.
            </p>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th colSpan="4">Vao receber email</th>
                </tr>
                <tr>
                  <th>Supervisor</th>
                  <th>Codigo</th>
                  <th>Nome</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {preview.recipients.length ? (
                  preview.recipients.map((item) => (
                    <tr key={`recipient-${item.entryId}`}>
                      <td>{item.supervisorCode}</td>
                      <td>{item.vendorCode}</td>
                      <td>{item.vendorName}</td>
                      <td>{item.email}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="4" className="muted">
                      Nenhum vendedor com email cadastrado neste mês.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th colSpan="4">Nao vao receber email</th>
                </tr>
                <tr>
                  <th>Supervisor</th>
                  <th>Codigo</th>
                  <th>Nome</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {preview.skipped.length ? (
                  preview.skipped.map((item) => (
                    <tr key={`skipped-${item.entryId}`}>
                      <td>{item.supervisorCode}</td>
                      <td>{item.vendorCode}</td>
                      <td>{item.vendorName}</td>
                      <td>{item.reason}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="4" className="muted">
                      Todos os vendedores deste mês possuem email cadastrado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="modal-actions">
            <button type="button" className="primary-btn" onClick={onConfirm} disabled={sending || !preview.recipients.length}>
              {sending ? "Enviando..." : "Confirmar envio"}
            </button>
            <button type="button" className="secondary-btn" onClick={onClose} disabled={sending}>
              Cancelar
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function MeiPage() {
  const { token, user } = useAuth();
  const [months, setMonths] = useState([]);
  const [referenceMonth, setReferenceMonth] = useState("");
  const [data, setData] = useState(null);
  const [vendorDirectory, setVendorDirectory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importFile, setImportFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState({});
  const [sending, setSending] = useState(false);
  const [actionLoading, setActionLoading] = useState("");
  const [editingEntry, setEditingEntry] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [creatingEntry, setCreatingEntry] = useState(false);
  const [emailBatchPreview, setEmailBatchPreview] = useState(null);
  const [sendingAllEmails, setSendingAllEmails] = useState(false);

  async function loadMonths() {
    const payload = await apiJson("/modules/mei/months", { token });
    setMonths(payload.months || []);

    if (!referenceMonth) {
      if (user?.role === "ADMIN") {
        setReferenceMonth((payload.months && payload.months[0]) || payload.defaultMonth);
      } else {
        setReferenceMonth(payload.defaultMonth);
      }
    }
  }

  async function loadOverview(targetMonth) {
    if (!targetMonth) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      const payload = await apiJson(`/modules/mei/overview?referenceMonth=${encodeURIComponent(targetMonth)}`, { token });
      setData(payload);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadVendorDirectory() {
    try {
      const payload = await apiJson("/vendor-directory", { token });
      setVendorDirectory(payload.records || []);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  useEffect(() => {
    loadMonths().catch((requestError) => setError(requestError.message));
    if (EMAIL_FEATURE_ENABLED) {
      loadVendorDirectory().catch((requestError) => setError(requestError.message));
    }
  }, [token]);

  useEffect(() => {
    loadOverview(referenceMonth);
  }, [token, referenceMonth]);

  const summaryItems = useMemo(() => {
    if (!data?.summary) {
      return [];
    }

    return [
      { label: "Vendedores", value: data.summary.totalVendors },
      { label: "Total de comissao", value: formatCurrency(data.summary.totalCommissionToReceive) },
      { label: "Pendentes", value: data.summary.pendingInvoices },
      { label: "Aprovadas", value: data.summary.approvedInvoices },
      { label: "Recusadas", value: data.summary.rejectedInvoices },
      { label: "Nao enviadas", value: data.summary.notSentInvoices }
    ];
  }, [data]);

  const vendorEmailMap = useMemo(
    () => new Map(vendorDirectory.map((record) => [Number(record.vendorCode), record.email])),
    [vendorDirectory]
  );

  async function handlePreviewImport() {
    if (!importFile || !referenceMonth) {
      setError("Selecione o arquivo .xlsx e o mes de referencia.");
      return;
    }

    setPreviewLoading(true);
    setError("");
    setNotice("");

    try {
      const formData = new FormData();
      formData.append("referenceMonth", referenceMonth);
      formData.append("file", importFile);
      const payload = await apiFormData("/modules/mei/import/preview", {
        token,
        data: formData
      });
      setPreview(payload);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleConfirmImport() {
    if (!preview) {
      return;
    }

    setActionLoading("confirm-import");
    setError("");
    setNotice("");

    try {
      const payload = await apiJson("/modules/mei/import/confirm", {
        method: "POST",
        token,
        data: {
          previewToken: preview.previewToken,
          referenceMonth,
          replaceExisting: Boolean(preview.existingBatch)
        }
      });
      setNotice(payload.message);
      setPreview(null);
      setImportFile(null);
      await loadMonths();
      await loadOverview(referenceMonth);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionLoading("");
    }
  }

  async function handleDownloadExtract(entryId) {
    const entry = data?.entries?.find((item) => item.id === entryId);
    await downloadFile(`/modules/mei/entries/${entryId}/extract`, {
      token,
      fileName: entry ? buildExtractDownloadFileName(entry) : `Extrato-${entryId}.pdf`
    });
  }

  async function handleDownloadInvoice(entry, submissionId, fileName) {
    await downloadFile(`/modules/mei/invoices/${submissionId}/download`, {
      token,
      fileName: buildInvoiceDownloadFileName(entry, fileName)
    });
  }

  async function handleApproveInvoice(submissionId) {
    setActionLoading(`approve-${submissionId}`);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson(`/modules/mei/invoices/${submissionId}/approve`, {
        method: "POST",
        token
      });
      setNotice(payload.message);
      await loadOverview(referenceMonth);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionLoading("");
    }
  }

  async function handleRejectInvoice(submissionId) {
    const reason = window.prompt("Motivo da recusa (opcional):", "") || "";
    setActionLoading(`reject-${submissionId}`);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson(`/modules/mei/invoices/${submissionId}/reject`, {
        method: "POST",
        token,
        data: { reason }
      });
      setNotice(payload.message);
      await loadOverview(referenceMonth);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionLoading("");
    }
  }

  async function handleApproveAll() {
    const confirmed = window.confirm("Aprovar todas as notas pendentes deste mes?");
    if (!confirmed) {
      return;
    }

    setActionLoading("approve-all");
    setError("");
    setNotice("");

    try {
      const payload = await apiJson("/modules/mei/invoices/approve-all", {
        method: "POST",
        token,
        data: { referenceMonth }
      });
      setNotice(payload.message);
      await loadOverview(referenceMonth);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionLoading("");
    }
  }

  async function handleDownloadAll() {
    await downloadFile(`/modules/mei/invoices/download-all?referenceMonth=${encodeURIComponent(referenceMonth)}`, {
      token,
      fileName: `notas-mei-${referenceMonth}.zip`
    });
  }

  async function handleDownloadAllExtracts() {
    await downloadFile(`/modules/mei/extracts/download-all?referenceMonth=${encodeURIComponent(referenceMonth)}`, {
      token,
      fileName: `extratos-mei-${referenceMonth}.zip`
    });
  }

  async function handlePreviewSendAllEmails() {
    setActionLoading("preview-send-all-emails");
    setError("");
    setNotice("");

    try {
      const payload = await apiJson(`/modules/mei/extract-emails/preview?referenceMonth=${encodeURIComponent(referenceMonth)}`, {
        token
      });
      setEmailBatchPreview(payload);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionLoading("");
    }
  }

  async function handleConfirmSendAllEmails() {
    setSendingAllEmails(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson("/modules/mei/extract-emails/send-all", {
        method: "POST",
        token,
        data: {
          referenceMonth
        }
      });
      setNotice(payload.message);
      setEmailBatchPreview(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSendingAllEmails(false);
    }
  }

  async function handleSendInvoices() {
    const items = Object.entries(selectedFiles).filter(([, file]) => file);
    if (!items.length) {
      setError("Selecione ao menos uma nota fiscal antes de enviar.");
      return;
    }

    setSending(true);
    setError("");
    setNotice("");

    try {
      for (const [entryId, file] of items) {
        const formData = new FormData();
        formData.append("entryId", entryId);
        formData.append("file", file);
        await apiFormData("/modules/mei/invoices", {
          token,
          data: formData
        });
      }

      setSelectedFiles({});
      window.alert("Notas fiscais enviadas com sucesso.");
      window.location.reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSending(false);
    }
  }

  function updateSelectedFile(entryId, file) {
    setSelectedFiles((current) => ({
      ...current,
      [entryId]: file || null
    }));
  }

  async function handleSaveEdit(form) {
    if (!editingEntry) {
      return;
    }

    setSavingEdit(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson(`/modules/mei/entries/${editingEntry.id}`, {
        method: "PUT",
        token,
        data: form
      });
      setNotice(payload.message);
      setEditingEntry(null);
      await loadOverview(referenceMonth);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleCreateEntry(form) {
    setSavingEdit(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson("/modules/mei/entries", {
        method: "POST",
        token,
        data: {
          ...form,
          referenceMonth
        }
      });
      setNotice(payload.message);
      setCreatingEntry(false);
      await loadOverview(referenceMonth);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleSendExtractEmail(entry) {
    const email = vendorEmailMap.get(Number(entry.vendorCode));
    if (!email) {
      setError("Cadastre um email para este vendedor na Base de Emails antes de disparar o extrato.");
      return;
    }

    const confirmed = window.confirm(`Enviar o extrato de ${entry.vendorName} para ${email}?`);
    if (!confirmed) {
      return;
    }

    setActionLoading(`send-email-${entry.id}`);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson(`/modules/mei/entries/${entry.id}/send-email`, {
        method: "POST",
        token
      });
      setNotice(payload.message);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionLoading("");
    }
  }

  return (
    <div className="page-stack">
      <section className="page-card compact-page-header">
        <div className="section-header">
          <div>
            <div className="eyebrow">Modulo de Pagamentos</div>
            <h1>MEI</h1>
            <p className="muted">
              {user?.role === "ADMIN"
                ? "Importe a planilha mensal, acompanhe as notas fiscais enviadas e feche as aprovacoes."
                : "Confira os vendedores do seu codigo de supervisor, baixe os extratos e envie as notas fiscais."}
            </p>
          </div>
          <div className="toolbar-actions">
            <input type="month" value={referenceMonth} onChange={(event) => setReferenceMonth(event.target.value)} />
          </div>
        </div>
        <div className="muted small">Mes selecionado: {formatMonthLabel(referenceMonth)}</div>
        {notice ? <p className="success-text">{notice}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      {summaryItems.length ? (
        <section className="summary-grid">
          {summaryItems.map((item) => (
            <article key={item.label} className="summary-chip">
              <span className="metric-label">{item.label}</span>
              <strong>{item.value}</strong>
            </article>
          ))}
        </section>
      ) : null}

      {user?.role === "ADMIN" ? (
        <section className="page-card">
          <div className="section-header">
            <div>
              <div className="eyebrow">Importacao</div>
              <h2>Planilha de comissoes</h2>
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
            <button type="button" className="secondary-btn" onClick={handlePreviewImport} disabled={previewLoading}>
              {previewLoading ? "Validando..." : "Carregar"}
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => setCreatingEntry(true)}
              disabled={!data?.hasBatch}
              title={data?.hasBatch ? "Adicionar vendedor manualmente neste periodo" : "Importe a planilha do periodo primeiro"}
            >
              Adicionar 1 pessoa
            </button>
          </div>

          {preview ? (
            <div className="callout-card">
              <strong>Preview pronto</strong>
              <p className="muted">
                Revise as diferencas no popup antes de confirmar a substituicao do periodo selecionado.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="table-card">
        <div className="section-header">
          <div>
            <div className="eyebrow">Operacao</div>
            <h2>{user?.role === "ADMIN" ? "Notas e aprovacoes" : "Vendedores e notas fiscais"}</h2>
          </div>
          {data?.hasBatch ? (
            <div className="toolbar-actions">
              <button type="button" className="secondary-btn compact-btn" onClick={handleDownloadAllExtracts}>
                Baixar todos os extratos
              </button>
              {user?.role === "ADMIN" ? (
                <>
              <button type="button" className="secondary-btn compact-btn" onClick={handleDownloadAll}>
                Baixar todas as notas
              </button>
              {EMAIL_FEATURE_ENABLED ? (
                <button
                  type="button"
                  className="secondary-btn compact-btn"
                  onClick={handlePreviewSendAllEmails}
                  disabled={actionLoading === "preview-send-all-emails"}
                >
                  {actionLoading === "preview-send-all-emails" ? "Carregando emails..." : "Enviar email para todos"}
                </button>
              ) : null}
              <button
                type="button"
                className="primary-btn compact-btn"
                onClick={handleApproveAll}
                disabled={actionLoading === "approve-all"}
              >
                {actionLoading === "approve-all" ? "Aprovando..." : "Aprovar todas"}
              </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        {loading ? (
          <div>Carregando dados do modulo MEI...</div>
        ) : !data?.hasBatch ? (
          <div className="empty-state">Nenhum lote encontrado para o mes selecionado.</div>
        ) : data.entries.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {user?.role === "ADMIN" ? <th>Supervisor</th> : null}
                  <th>Codigo vendedor</th>
                  <th>Nome</th>
                  <th>Comissao</th>
                  <th>Status</th>
                  <th>Detalhes</th>
                  <th>Acoes</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => {
                  const canUpload = entry.invoiceStatus !== "APPROVED" && entry.invoiceStatus !== "PENDING";
                  const currentSubmission = entry.currentSubmission;
                  const vendorEmail = vendorEmailMap.get(Number(entry.vendorCode)) || "";

                  return (
                    <tr key={entry.id}>
                      {user?.role === "ADMIN" ? <td>{entry.supervisorCode}</td> : null}
                      <td>{entry.vendorCode}</td>
                      <td>{entry.vendorName}</td>
                      <td>{formatCurrency(entry.commissionToReceive)}</td>
                      <td>
                        <span className={`status-pill ${statusTone(entry.invoiceStatus)}`}>{statusLabel(entry.invoiceStatus)}</span>
                      </td>
                      <td>
                        {currentSubmission?.originalFileName ? (
                          <div className="row-file-name" title={currentSubmission.originalFileName}>
                            {previewFileName(currentSubmission.originalFileName)}
                          </div>
                        ) : null}
                        {currentSubmission?.rejectionReason ? (
                          <div className="muted small">Motivo: {currentSubmission.rejectionReason}</div>
                        ) : null}
                        {!currentSubmission ? <div className="muted small">Sem nota enviada.</div> : null}
                      </td>
                      <td>
                        <div className="inline-actions">
                          <button
                            type="button"
                            className="icon-action-btn"
                            onClick={() => handleDownloadExtract(entry.id)}
                            title="Baixar extrato"
                            aria-label="Baixar extrato"
                          >
                            <ExtractDownloadIcon />
                          </button>

                          {EMAIL_FEATURE_ENABLED ? (
                            <button
                              type="button"
                              className="icon-action-btn is-email"
                              onClick={() => handleSendExtractEmail(entry)}
                              disabled={!vendorEmail || actionLoading === `send-email-${entry.id}`}
                              title={
                                vendorEmail
                                  ? `Enviar extrato por email para ${vendorEmail}`
                                  : "Cadastre um email para este vendedor na base de emails"
                              }
                              aria-label={
                                vendorEmail
                                  ? `Enviar extrato por email para ${vendorEmail}`
                                  : "Cadastre um email para este vendedor na base de emails"
                              }
                            >
                              <EmailSendIcon />
                            </button>
                          ) : null}

                          {user?.role === "USER" ? (
                            <>
                              <FilePicker
                                compact
                                accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx"
                                file={selectedFiles[entry.id]}
                                disabled={!canUpload}
                                buttonLabel="Escolher arquivo"
                                placeholder="Nenhum arquivo selecionado"
                                onChange={(file) => updateSelectedFile(entry.id, file)}
                              />
                            </>
                          ) : null}

                          {user?.role === "ADMIN" && currentSubmission ? (
                            <>
                              <button
                                type="button"
                                className="icon-action-btn"
                                onClick={() => handleDownloadInvoice(entry, currentSubmission.id, currentSubmission.originalFileName)}
                                title="Baixar nota fiscal"
                                aria-label="Baixar nota fiscal"
                              >
                                <InvoiceDownloadIcon />
                              </button>
                              {entry.invoiceStatus !== "APPROVED" ? (
                                <button
                                  type="button"
                                  className="icon-action-btn is-approve"
                                  onClick={() => handleApproveInvoice(currentSubmission.id)}
                                  disabled={actionLoading === `approve-${currentSubmission.id}`}
                                  title="Aprovar nota fiscal"
                                  aria-label="Aprovar nota fiscal"
                                >
                                  <ApproveIcon />
                                </button>
                              ) : null}
                              {entry.invoiceStatus !== "REJECTED" ? (
                                <button
                                  type="button"
                                  className="icon-action-btn is-reject"
                                  onClick={() => handleRejectInvoice(currentSubmission.id)}
                                  disabled={actionLoading === `reject-${currentSubmission.id}`}
                                  title="Recusar nota fiscal"
                                  aria-label="Recusar nota fiscal"
                                >
                                  <RejectIcon />
                                </button>
                              ) : null}
                            </>
                          ) : null}

                          {user?.role === "ADMIN" ? (
                            <button
                              type="button"
                              className="icon-action-btn is-edit"
                              onClick={() => setEditingEntry(entry)}
                              title="Editar entrada"
                              aria-label="Editar entrada"
                            >
                              <EditIcon />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">Nenhum vendedor encontrado para o mes selecionado.</div>
        )}
      </section>

      {user?.role === "USER" && data?.hasBatch ? (
        <section className="page-card">
          <div className="section-header">
            <div>
              <div className="eyebrow">Envio</div>
              <h2>Enviar notas fiscais</h2>
            </div>
            <button type="button" className="primary-btn" onClick={handleSendInvoices} disabled={sending}>
              {sending ? "Enviando..." : "Enviar"}
            </button>
          </div>
          <p className="muted">
            Total das comissoes do mes: <strong>{formatCurrency(data.summary.totalCommissionToReceive)}</strong>
          </p>
        </section>
      ) : null}

      {editingEntry ? (
        <EditEntryModal entry={editingEntry} saving={savingEdit} onClose={() => setEditingEntry(null)} onSave={handleSaveEdit} />
      ) : null}

      {preview ? (
        <ImportPreviewModal
          preview={preview}
          loading={actionLoading === "confirm-import"}
          onClose={() => setPreview(null)}
          onConfirm={handleConfirmImport}
        />
      ) : null}

      {creatingEntry ? (
        <EditEntryModal
          entry={{
            id: null,
            ...getReferenceMonthRange(referenceMonth),
            supervisorCode: "",
            vendorCode: "",
            vendorName: "",
            grossSales: 0,
            returnsAmount: 0,
            netSales: 0,
            advanceAmount: 0,
            delinquencyAmount: 0,
            grossCommission: 0,
            averageCommissionPercent: 0,
            reversalAmount: 0,
            totalCommissionToInvoice: 0,
            commissionToReceive: 0
          }}
          saving={savingEdit}
          onClose={() => setCreatingEntry(false)}
          onSave={handleCreateEntry}
        />
      ) : null}

      {EMAIL_FEATURE_ENABLED && emailBatchPreview ? (
        <BulkEmailModal
          preview={emailBatchPreview}
          sending={sendingAllEmails}
          onClose={() => setEmailBatchPreview(null)}
          onConfirm={handleConfirmSendAllEmails}
        />
      ) : null}
    </div>
  );
}
