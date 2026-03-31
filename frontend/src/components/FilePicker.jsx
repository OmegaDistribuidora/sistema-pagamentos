import { useId } from "react";

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path d="M12 4a1 1 0 0 1 1 1v7.59l1.3-1.29a1 1 0 1 1 1.4 1.41l-3 3a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.41l1.3 1.29V5a1 1 0 0 1 1-1Z" fill="currentColor" />
      <path d="M6 16a1 1 0 0 1 1 1v1h10v-1a1 1 0 1 1 2 0v1.5A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5V17a1 1 0 0 1 1-1Z" fill="currentColor" />
    </svg>
  );
}

export default function FilePicker({ file, accept, disabled, buttonLabel, placeholder, onChange, compact = false }) {
  const inputId = useId();

  return (
    <div className={`file-picker ${compact ? "is-compact" : ""} ${disabled ? "is-disabled" : ""}`}>
      <input
        id={inputId}
        className="file-picker-input"
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(event) => onChange(event.target.files?.[0] || null)}
      />
      <label htmlFor={disabled ? undefined : inputId} className="file-picker-trigger">
        <UploadIcon />
        <span>{buttonLabel}</span>
      </label>
      <span className="file-picker-name">{file?.name || placeholder}</span>
    </div>
  );
}
