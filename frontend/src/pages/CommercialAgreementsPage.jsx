import { useEffect, useMemo, useState } from "react";
import { apiFormData, apiJson, downloadFile } from "../services/api";
import { useAuth } from "../components/AuthProvider";

const AGREEMENT_TYPES = [
  ["INSERT", "Encarte"],
  ["LOYALTY", "Fidelização"],
  ["STORE_OUTFIT", "Enxoval de loja"],
  ["PRODUCT_REGISTRY", "Cadastro de Produtos"],
  ["EXTRA_POINT", "Ponto Extra"],
  ["OTHER", "Outros"]
];

const ATTACHMENT_CATEGORIES = [
  ["INVOICES", "Boletos", true],
  ["TAX_INVOICE", "Nota Fiscal", false],
  ["CONTRACT", "Contrato/Termo de Ocorrência", false],
  ["SALES_REPORT", "Relatório de vendas", true],
  ["PHOTOS", "Fotos", true]
];

const STATUS_LABELS = {
  PENDING: "Pendente",
  APPROVED: "Aprovada",
  REJECTED: "Recusada"
};

const TYPE_LABELS = Object.fromEntries(AGREEMENT_TYPES);
const ATTACHMENT_LABELS = Object.fromEntries(ATTACHMENT_CATEGORIES.map(([key, label]) => [key, label]));
const PRODUCT_TYPES = new Set(["INSERT", "PRODUCT_REGISTRY", "EXTRA_POINT"]);

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function digitsFromAmount(value) {
  return String(Math.round(Number(value || 0) * 100));
}

function formatCurrencyDigits(digits) {
  const value = Number(String(digits || "").replace(/\D/g, "") || 0) / 100;
  return formatCurrency(value);
}

function amountFromDigits(digits) {
  return Number(String(digits || "").replace(/\D/g, "") || 0) / 100;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function createEmptyAttachments() {
  return Object.fromEntries(ATTACHMENT_CATEGORIES.map(([category]) => [category, []]));
}

function createFormState(existing) {
  return {
    audienceType: existing?.audienceType || "NETWORK",
    networkCode: existing?.networkCode ? String(existing.networkCode) : "",
    clientCodes: existing?.clientCodes?.length ? existing.clientCodes.map(String) : [""],
    agreementType: existing?.agreementType || "INSERT",
    otherDescription: existing?.otherDescription || "",
    totalAmountDigits: digitsFromAmount(existing?.totalAmount || 0),
    splitAmount: Boolean(existing?.splitAmount),
    suppliers: existing?.suppliers?.length
      ? existing.suppliers.map((item) => ({
          supplierCode: String(item.supplierCode),
          allocatedAmountDigits: digitsFromAmount(item.allocatedAmount)
        }))
      : [{ supplierCode: "", allocatedAmountDigits: "0" }],
    multipleProducts: (existing?.productCodes?.length || 0) > 1,
    productCodes: existing?.productCodes?.length ? existing.productCodes.map(String) : [""],
    notes: existing?.notes || "",
    attachments: createEmptyAttachments()
  };
}

function updateListValue(setForm, field, index, value) {
  setForm((current) => ({
    ...current,
    [field]: current[field].map((item, itemIndex) => (itemIndex === index ? value : item))
  }));
}

function RequestFormModal({ existing, saving, error, onClose, onSubmit }) {
  const [form, setForm] = useState(() => createFormState(existing));
  const requiresProducts = PRODUCT_TYPES.has(form.agreementType);
  const existingAttachments = useMemo(() => {
    const counts = {};
    for (const attachment of existing?.attachments || []) {
      counts[attachment.category] = (counts[attachment.category] || 0) + 1;
    }
    return counts;
  }, [existing]);
  const allocatedTotal = form.splitAmount
    ? form.suppliers.reduce((sum, item) => sum + amountFromDigits(item.allocatedAmountDigits), 0)
    : amountFromDigits(form.totalAmountDigits);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateSupplier(index, field, value) {
    setForm((current) => ({
      ...current,
      suppliers: current.suppliers.map((supplier, supplierIndex) =>
        supplierIndex === index ? { ...supplier, [field]: value } : supplier
      )
    }));
  }

  function submit(event) {
    event.preventDefault();
    const payload = {
      audienceType: form.audienceType,
      networkCode: form.audienceType === "NETWORK" ? Number(form.networkCode) : null,
      clientCodes: form.audienceType === "SPECIFIC_CLIENTS" ? form.clientCodes.map(Number) : [],
      agreementType: form.agreementType,
      otherDescription: form.otherDescription,
      totalAmount: amountFromDigits(form.totalAmountDigits),
      splitAmount: form.splitAmount,
      suppliers: form.suppliers.map((supplier) => ({
        supplierCode: Number(supplier.supplierCode),
        allocatedAmount: form.splitAmount ? amountFromDigits(supplier.allocatedAmountDigits) : undefined
      })),
      productCodes: requiresProducts ? form.productCodes.map(Number) : [],
      notes: form.notes
    };

    const data = new FormData();
    data.append("payload", JSON.stringify(payload));
    for (const [category, files] of Object.entries(form.attachments)) {
      files.forEach((file) => data.append(category, file));
    }
    onSubmit(data);
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={saving ? undefined : onClose}>
      <section className="modal-card commercial-agreement-form-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Acordos Comerciais</div>
            <h2>{existing ? "Corrigir e reenviar solicitação" : "Nova solicitação"}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} disabled={saving} aria-label="Fechar">×</button>
        </div>

        <form className="form-stack" onSubmit={submit}>
          {existing?.rejectionReason ? (
            <div className="agreement-rejection-callout">
              <strong>Motivo da recusa</strong>
              <p>{existing.rejectionReason}</p>
            </div>
          ) : null}

          <section className="agreement-form-section">
            <h3>Destino do acordo</h3>
            <div className="commercial-agreement-grid">
              <label>
                Referente a
                <select value={form.audienceType} onChange={(event) => updateField("audienceType", event.target.value)} required>
                  <option value="NETWORK">Rede de clientes</option>
                  <option value="SPECIFIC_CLIENTS">Clientes específicos</option>
                </select>
              </label>
              {form.audienceType === "NETWORK" ? (
                <label>
                  Código da rede
                  <input inputMode="numeric" value={form.networkCode} onChange={(event) => updateField("networkCode", onlyDigits(event.target.value))} required />
                </label>
              ) : null}
            </div>

            {form.audienceType === "SPECIFIC_CLIENTS" ? (
              <div className="dynamic-list">
                <strong>Códigos dos clientes</strong>
                {form.clientCodes.map((code, index) => (
                  <div className="dynamic-row" key={`client-${index}`}>
                    <input
                      aria-label={`Código do cliente ${index + 1}`}
                      inputMode="numeric"
                      value={code}
                      onChange={(event) => updateListValue(setForm, "clientCodes", index, onlyDigits(event.target.value))}
                      required
                    />
                    {form.clientCodes.length > 1 ? (
                      <button type="button" className="secondary-btn compact-btn" onClick={() => updateField("clientCodes", form.clientCodes.filter((_, itemIndex) => itemIndex !== index))}>Remover</button>
                    ) : null}
                  </div>
                ))}
                <button type="button" className="secondary-btn compact-btn align-start" onClick={() => updateField("clientCodes", [...form.clientCodes, ""])}>Adicionar outro cliente</button>
              </div>
            ) : null}
          </section>

          <section className="agreement-form-section">
            <h3>Dados comerciais</h3>
            <div className="commercial-agreement-grid">
              <label>
                Tipo de acordo comercial
                <select value={form.agreementType} onChange={(event) => updateField("agreementType", event.target.value)} required>
                  {AGREEMENT_TYPES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              <label>
                Valor total
                <input
                  className="currency-input"
                  inputMode="numeric"
                  value={formatCurrencyDigits(form.totalAmountDigits)}
                  onChange={(event) => updateField("totalAmountDigits", onlyDigits(event.target.value))}
                  required
                />
              </label>
            </div>
            {form.agreementType === "OTHER" ? (
              <label>
                Descrição do acordo
                <input value={form.otherDescription} onChange={(event) => updateField("otherDescription", event.target.value)} maxLength={500} required />
              </label>
            ) : null}

            <label className="inline-check">
              <input
                type="checkbox"
                checked={form.splitAmount}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setForm((current) => ({
                    ...current,
                    splitAmount: checked,
                    suppliers: checked
                      ? current.suppliers.length >= 2
                        ? current.suppliers
                        : [...current.suppliers, { supplierCode: "", allocatedAmountDigits: "0" }]
                      : [current.suppliers[0] || { supplierCode: "", allocatedAmountDigits: "0" }]
                  }));
                }}
              />
              Ratear valor entre fornecedores
            </label>

            <div className="dynamic-list">
              <strong>{form.splitAmount ? "Fornecedores e valores rateados" : "Código do fornecedor"}</strong>
              {form.suppliers.map((supplier, index) => (
                <div className="dynamic-row supplier-row" key={`supplier-${index}`}>
                  <input
                    aria-label={`Código do fornecedor ${index + 1}`}
                    placeholder="Código do fornecedor"
                    inputMode="numeric"
                    value={supplier.supplierCode}
                    onChange={(event) => updateSupplier(index, "supplierCode", onlyDigits(event.target.value))}
                    required
                  />
                  {form.splitAmount ? (
                    <input
                      aria-label={`Valor do fornecedor ${index + 1}`}
                      className="currency-input"
                      inputMode="numeric"
                      value={formatCurrencyDigits(supplier.allocatedAmountDigits)}
                      onChange={(event) => updateSupplier(index, "allocatedAmountDigits", onlyDigits(event.target.value))}
                      required
                    />
                  ) : null}
                  {form.splitAmount && form.suppliers.length > 2 ? (
                    <button type="button" className="secondary-btn compact-btn" onClick={() => updateField("suppliers", form.suppliers.filter((_, itemIndex) => itemIndex !== index))}>Remover</button>
                  ) : null}
                </div>
              ))}
              {form.splitAmount ? (
                <>
                  <button type="button" className="secondary-btn compact-btn align-start" onClick={() => updateField("suppliers", [...form.suppliers, { supplierCode: "", allocatedAmountDigits: "0" }])}>Adicionar fornecedor</button>
                  <div className={Math.round(allocatedTotal * 100) === Math.round(amountFromDigits(form.totalAmountDigits) * 100) ? "success-text small" : "error-text small"}>
                    Total rateado: {formatCurrency(allocatedTotal)} de {formatCurrency(amountFromDigits(form.totalAmountDigits))}
                  </div>
                </>
              ) : null}
            </div>

            {requiresProducts ? (
              <div className="dynamic-list">
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={form.multipleProducts}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setForm((current) => ({
                        ...current,
                        multipleProducts: checked,
                        productCodes: checked ? current.productCodes : [current.productCodes[0] || ""]
                      }));
                    }}
                  />
                  Múltiplos produtos
                </label>
                <strong>Código do produto</strong>
                {form.productCodes.map((code, index) => (
                  <div className="dynamic-row" key={`product-${index}`}>
                    <input
                      aria-label={`Código do produto ${index + 1}`}
                      inputMode="numeric"
                      value={code}
                      onChange={(event) => updateListValue(setForm, "productCodes", index, onlyDigits(event.target.value))}
                      required
                    />
                    {form.multipleProducts && form.productCodes.length > 1 ? (
                      <button type="button" className="secondary-btn compact-btn" onClick={() => updateField("productCodes", form.productCodes.filter((_, itemIndex) => itemIndex !== index))}>Remover</button>
                    ) : null}
                  </div>
                ))}
                {form.multipleProducts ? (
                  <button type="button" className="secondary-btn compact-btn align-start" onClick={() => updateField("productCodes", [...form.productCodes, ""])}>Adicionar produto</button>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="agreement-form-section">
            <h3>Anexos</h3>
            <p className="muted small">PDF ou imagem, até 10 MB por arquivo. É possível selecionar vários arquivos em cada categoria.</p>
            <div className="attachment-grid">
              {ATTACHMENT_CATEGORIES.map(([category, label, normallyRequired]) => {
                const required = normallyRequired && !(category === "PHOTOS" && form.agreementType === "STORE_OUTFIT");
                const existingCount = existingAttachments[category] || 0;
                const selectedCount = form.attachments[category].length;
                return (
                  <label className="attachment-picker" key={category}>
                    <span>{label} {required ? <strong className="required-mark">*</strong> : "(opcional)"}</span>
                    <input
                      type="file"
                      multiple
                      accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.bmp"
                      onChange={(event) => {
                        const files = Array.from(event.target.files || []);
                        setForm((current) => ({
                          ...current,
                          attachments: { ...current.attachments, [category]: files }
                        }));
                      }}
                      required={!existing && required}
                    />
                    <small className="muted">
                      {selectedCount
                        ? `${selectedCount} novo(s) arquivo(s) selecionado(s)`
                        : existingCount
                          ? `${existingCount} arquivo(s) existente(s) será(ão) mantido(s)`
                          : "Nenhum arquivo selecionado"}
                    </small>
                    {existingCount && selectedCount ? <small className="muted">Os arquivos existentes desta categoria serão substituídos.</small> : null}
                  </label>
                );
              })}
            </div>
          </section>

          <label>
            Observação (opcional)
            <textarea rows="4" value={form.notes} onChange={(event) => updateField("notes", event.target.value)} maxLength={2000} />
          </label>

          {error ? <p className="error-text">{error}</p> : null}
          <div className="modal-actions">
            <button type="submit" className="primary-btn" disabled={saving}>{saving ? "Enviando..." : existing ? "Reenviar solicitação" : "Enviar solicitação"}</button>
            <button type="button" className="secondary-btn" onClick={onClose} disabled={saving}>Cancelar</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function DetailItem({ label, children }) {
  return <div className="agreement-detail-item"><span>{label}</span><strong>{children || "-"}</strong></div>;
}

function AgreementDetailModal({ agreement, canReview, currentUserId, actionLoading, error, onClose, onApprove, onReject, onEdit, onDownload }) {
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const isOwner = agreement.requester?.id === currentUserId;

  return (
    <div className="modal-backdrop" role="presentation" onClick={actionLoading ? undefined : onClose}>
      <section className="modal-card commercial-agreement-detail-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Solicitação #{agreement.id}</div>
            <h2>{TYPE_LABELS[agreement.agreementType]}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} disabled={actionLoading} aria-label="Fechar">×</button>
        </div>

        <div className="modal-stack">
          <div className="agreement-detail-grid">
            <DetailItem label="Status"><span className={`status-pill is-${agreement.status.toLowerCase()}`}>{STATUS_LABELS[agreement.status]}</span></DetailItem>
            <DetailItem label="Solicitante">{agreement.requester?.displayName}</DetailItem>
            <DetailItem label="Enviado em">{formatDateTime(agreement.submittedAt)}</DetailItem>
            <DetailItem label="Valor total">{formatCurrency(agreement.totalAmount)}</DetailItem>
            <DetailItem label="Destino">{agreement.audienceType === "NETWORK" ? `Rede ${agreement.networkCode}` : `Clientes ${agreement.clientCodes.join(", ")}`}</DetailItem>
            <DetailItem label="Tipo">{agreement.agreementType === "OTHER" ? agreement.otherDescription : TYPE_LABELS[agreement.agreementType]}</DetailItem>
            <DetailItem label="Produtos">{agreement.productCodes?.length ? agreement.productCodes.join(", ") : "Não se aplica"}</DetailItem>
            <DetailItem label="Analisado por">{agreement.reviewer?.displayName || "Aguardando análise"}</DetailItem>
          </div>

          <section className="agreement-detail-section">
            <h3>{agreement.splitAmount ? "Rateio por fornecedor" : "Fornecedor"}</h3>
            <div className="agreement-supplier-list">
              {agreement.suppliers.map((supplier) => (
                <div key={supplier.supplierCode}><strong>Código {supplier.supplierCode}</strong><span>{formatCurrency(supplier.allocatedAmount)}</span></div>
              ))}
            </div>
          </section>

          {agreement.rejectionReason ? <div className="agreement-rejection-callout"><strong>Motivo da recusa</strong><p>{agreement.rejectionReason}</p></div> : null}
          {agreement.notes ? <section className="agreement-detail-section"><h3>Observação</h3><p>{agreement.notes}</p></section> : null}

          <section className="agreement-detail-section">
            <h3>Anexos</h3>
            <div className="attachment-download-list">
              {agreement.attachments.map((attachment) => (
                <button type="button" className="secondary-btn" key={attachment.id} onClick={() => onDownload(attachment)}>
                  {ATTACHMENT_LABELS[attachment.category]}: {attachment.originalFileName}
                </button>
              ))}
            </div>
          </section>

          {canReview && agreement.history?.length ? (
            <section className="agreement-detail-section">
              <h3>Histórico da solicitação</h3>
              <div className="agreement-history-list">
                {agreement.history.map((event) => (
                  <article key={event.id}>
                    <div><strong>{event.summary}</strong><span>{formatDateTime(event.createdAt)}</span></div>
                    <small className="muted">{event.actor?.displayName || event.actor?.username || "Sistema"}</small>
                    {event.details?.reason ? <p>Motivo: {event.details.reason}</p> : null}
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {showReject ? (
            <section className="agreement-reject-box">
              <label>
                Motivo da recusa
                <textarea rows="4" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} maxLength={1000} autoFocus />
              </label>
              <div className="modal-actions">
                <button type="button" className="primary-btn danger-btn" disabled={actionLoading || !rejectReason.trim()} onClick={() => onReject(rejectReason)}>Confirmar recusa</button>
                <button type="button" className="secondary-btn" onClick={() => setShowReject(false)} disabled={actionLoading}>Cancelar</button>
              </div>
            </section>
          ) : null}

          {error ? <p className="error-text">{error}</p> : null}

          <div className="modal-actions">
            {canReview && agreement.status === "PENDING" ? (
              <>
                <button type="button" className="primary-btn" onClick={onApprove} disabled={actionLoading}>Aprovar</button>
                <button type="button" className="secondary-btn danger-text" onClick={() => setShowReject(true)} disabled={actionLoading}>Recusar</button>
              </>
            ) : null}
            {isOwner && agreement.status === "REJECTED" ? (
              <button type="button" className="primary-btn" onClick={onEdit} disabled={actionLoading}>Editar e reenviar</button>
            ) : null}
            <button type="button" className="secondary-btn" onClick={onClose} disabled={actionLoading}>Fechar</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function AgreementTable({ title, description, agreements, tone, canReview, onOpen }) {
  return (
    <section className={`table-card agreement-block ${tone || ""}`}>
      <div className="section-header">
        <div><div className="eyebrow">{agreements.length} solicitação(ões)</div><h2>{title}</h2><p className="muted">{description}</p></div>
      </div>
      {agreements.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nº</th>{canReview ? <th>Solicitante</th> : null}<th>Tipo</th><th>Destino</th><th>Fornecedor(es)</th><th>Valor</th><th>Atualização</th><th>Status</th></tr></thead>
            <tbody>
              {agreements.map((agreement) => (
                <tr className="clickable-row" key={agreement.id} tabIndex="0" onClick={() => onOpen(agreement.id)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(agreement.id); }}>
                  <td>#{agreement.id}</td>
                  {canReview ? <td>{agreement.requester.displayName}</td> : null}
                  <td>{TYPE_LABELS[agreement.agreementType]}</td>
                  <td>{agreement.audienceType === "NETWORK" ? `Rede ${agreement.networkCode}` : `${agreement.clientCodes.length} cliente(s)`}</td>
                  <td>{agreement.suppliers.map((item) => item.supplierCode).join(", ")}</td>
                  <td>{formatCurrency(agreement.totalAmount)}</td>
                  <td>{formatDateTime(agreement.updatedAt)}</td>
                  <td><span className={`status-pill is-${agreement.status.toLowerCase()}`}>{STATUS_LABELS[agreement.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="empty-state">Nenhuma solicitação nesta situação.</div>}
    </section>
  );
}

export default function CommercialAgreementsPage() {
  const { token, user } = useAuth();
  const [agreements, setAgreements] = useState([]);
  const [requesters, setRequesters] = useState([]);
  const [canReview, setCanReview] = useState(false);
  const [requesterFilter, setRequesterFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingAgreement, setEditingAgreement] = useState(null);
  const [selectedAgreement, setSelectedAgreement] = useState(null);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  async function loadAgreements() {
    setLoading(true);
    setError("");
    try {
      const payload = await apiJson("/modules/commercial-agreements", { token });
      setAgreements(payload.agreements || []);
      setRequesters(payload.requesters || []);
      setCanReview(Boolean(payload.canReview));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAgreements(); }, [token]);

  async function openAgreement(id) {
    setActionLoading(true);
    setError("");
    try {
      const payload = await apiJson(`/modules/commercial-agreements/${id}`, { token });
      setSelectedAgreement(payload.agreement);
      setCanReview(Boolean(payload.canReview));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionLoading(false);
    }
  }

  async function submitRequest(data) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = editingAgreement
        ? await apiFormData(`/modules/commercial-agreements/${editingAgreement.id}/resubmit`, { method: "PUT", token, data })
        : await apiFormData("/modules/commercial-agreements", { token, data });
      setNotice(payload.message);
      setFormOpen(false);
      setEditingAgreement(null);
      setSelectedAgreement(null);
      await loadAgreements();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  async function approveSelected() {
    if (!selectedAgreement || !window.confirm(`Aprovar a solicitação #${selectedAgreement.id}?`)) return;
    setActionLoading(true);
    setError("");
    try {
      const payload = await apiJson(`/modules/commercial-agreements/${selectedAgreement.id}/approve`, { method: "POST", token });
      setNotice(payload.message);
      setSelectedAgreement(null);
      await loadAgreements();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionLoading(false);
    }
  }

  async function rejectSelected(reason) {
    if (!selectedAgreement) return;
    setActionLoading(true);
    setError("");
    try {
      const payload = await apiJson(`/modules/commercial-agreements/${selectedAgreement.id}/reject`, { method: "POST", token, data: { reason } });
      setNotice(payload.message);
      setSelectedAgreement(null);
      await loadAgreements();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionLoading(false);
    }
  }

  async function downloadAttachment(attachment) {
    if (!selectedAgreement) return;
    try {
      await downloadFile(`/modules/commercial-agreements/${selectedAgreement.id}/attachments/${attachment.id}/download`, { token, fileName: attachment.originalFileName });
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  const visibleAgreements = requesterFilter
    ? agreements.filter((agreement) => String(agreement.requester.id) === requesterFilter)
    : agreements;
  const rejected = visibleAgreements.filter((agreement) => agreement.status === "REJECTED");
  const pending = visibleAgreements.filter((agreement) => agreement.status === "PENDING");
  const approved = visibleAgreements.filter((agreement) => agreement.status === "APPROVED");

  return (
    <div className="page-stack commercial-agreements-page">
      <section className="page-card compact-page-header">
        <div className="section-header">
          <div><div className="eyebrow">Módulo de Pagamentos</div><h1>Acordos Comerciais</h1><p className="muted">Crie e acompanhe solicitações de verbas para ações comerciais com fornecedores.</p></div>
          <div className="toolbar-actions"><button type="button" className="primary-btn" onClick={() => { setEditingAgreement(null); setFormOpen(true); setError(""); }}>Nova solicitação</button></div>
        </div>
        {canReview ? (
          <div className="agreement-review-filter">
            <label>Filtrar por solicitante<select value={requesterFilter} onChange={(event) => setRequesterFilter(event.target.value)}><option value="">Todos os usuários</option>{requesters.map((requester) => <option key={requester.id} value={requester.id}>{requester.displayName} ({requester.username})</option>)}</select></label>
          </div>
        ) : null}
        {notice ? <p className="success-text">{notice}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="summary-grid">
        <article className="summary-chip"><span className="metric-label">Pendentes</span><strong>{pending.length}</strong></article>
        <article className="summary-chip"><span className="metric-label">Aprovadas</span><strong>{approved.length}</strong></article>
        <article className="summary-chip"><span className="metric-label">Recusadas</span><strong>{rejected.length}</strong></article>
        <article className="summary-chip"><span className="metric-label">Valor pendente</span><strong>{formatCurrency(pending.reduce((sum, item) => sum + Number(item.totalAmount), 0))}</strong></article>
      </section>

      {loading ? <section className="page-card"><p className="muted">Carregando solicitações...</p></section> : (
        <>
          {rejected.length ? <AgreementTable title="Solicitações recusadas" description={canReview ? "Solicitações devolvidas aos usuários para correção." : "Revise o motivo, corrija os dados e reenvie para análise."} agreements={rejected} tone="is-rejected" canReview={canReview} onOpen={openAgreement} /> : null}
          <AgreementTable title="Solicitações pendentes" description={canReview ? "Aguardando sua análise." : "Enviadas e aguardando análise."} agreements={pending} tone="is-pending" canReview={canReview} onOpen={openAgreement} />
          <AgreementTable title="Solicitações concluídas" description="Solicitações aprovadas." agreements={approved} tone="is-approved" canReview={canReview} onOpen={openAgreement} />
        </>
      )}

      {formOpen ? <RequestFormModal key={editingAgreement?.id || "new"} existing={editingAgreement} saving={saving} error={error} onClose={() => { if (!saving) { setFormOpen(false); setEditingAgreement(null); } }} onSubmit={submitRequest} /> : null}
      {selectedAgreement ? <AgreementDetailModal agreement={selectedAgreement} canReview={canReview} currentUserId={user?.id} actionLoading={actionLoading} error={error} onClose={() => setSelectedAgreement(null)} onApprove={approveSelected} onReject={rejectSelected} onEdit={() => { setEditingAgreement(selectedAgreement); setSelectedAgreement(null); setFormOpen(true); setError(""); }} onDownload={downloadAttachment} /> : null}
    </div>
  );
}
