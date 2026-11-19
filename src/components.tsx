import { useEffect, useId, useRef, type ReactNode } from 'react';
import { CheckCircle2, CircleAlert, CircleX, LoaderCircle, X } from 'lucide-react';

export function Badge({ status }: { status: string }) {
  const tone = ['Ready', 'Completed', 'Converted', 'ReadyToMigrate', 'Reconciled'].includes(status) ? 'success'
    : ['Needs review', 'Interrupted', 'NeedsAttention', 'Partial', 'Needs reconciliation'].includes(status) ? 'warning'
      : ['Blocked', 'Failed', 'UpgradeUnavailable'].includes(status) ? 'danger' : 'neutral';
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'danger' ? CircleX
    : status === 'Running' ? LoaderCircle : CircleAlert;
  return <span className={`badge ${tone}`}><Icon size={13} className={status === 'Running' ? 'spin' : ''} />{status}</span>;
}

export function Checkbox({ checked, mixed = false, onChange, label, disabled = false }: {
  checked: boolean; mixed?: boolean; onChange: () => void; label: string; disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />;
}

export function Modal({ title, children, onClose, drawer = false }: {
  title: string; children: ReactNode; onClose: () => void; drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return <dialog ref={ref} className={drawer ? 'dialog drawer' : 'dialog'} aria-labelledby={titleId}
    onCancel={e => { e.preventDefault(); onClose(); }}>
    <header className="dialog-header"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></header>
    {children}
  </dialog>;
}

export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function dateLabel(value: string | null) {
  if (!value) return 'Not provided';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
