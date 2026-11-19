import { useEffect, useState } from 'react';
import { ArrowRight, LoaderCircle, LogIn, LogOut, ShieldCheck } from 'lucide-react';
import { Modal } from './components';
import { prepareTenant } from './tenantAuth';
import type { TenantInventoryController } from './useTenantInventory';

export default function TenantConnection({ tenant, disabled }: { tenant: TenantInventoryController; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [validation, setValidation] = useState('');
  useEffect(() => {
    let active = true;
    setPrepared(false);
    if (!tenant.config) return;
    void prepareTenant(tenant.config).then(() => { if (active) setPrepared(true); }).catch((reason: unknown) => {
      if (active) setValidation(`Could not prepare Microsoft sign-in. ${reason instanceof Error ? reason.message : String(reason)}`);
    });
    return () => { active = false; };
  }, [tenant.config]);
  return <>
    <button className={`button ${tenant.isLive ? '' : 'connect-button'}`} disabled={disabled || tenant.loading}
      onClick={() => setOpen(true)}><LogIn size={15} />{tenant.isLive ? 'Reconnect' : 'Connect tenant'}</button>
    {tenant.session && <button className="button" disabled={disabled} aria-label="Disconnect tenant" title="Disconnect tenant"
      onClick={() => void tenant.disconnect()}><LogOut size={15} />Disconnect</button>}
    {open && <Modal title="Connect your Microsoft account" onClose={() => { if (!tenant.loading) setOpen(false); }}>
      <form onSubmit={async event => {
        event.preventDefault();
        if (tenant.config && prepared && await tenant.connect(tenant.config)) setOpen(false);
      }}>
        <div className="dialog-body"><div className="review-intro"><span className="review-icon"><ShieldCheck size={24} /></span><div>
          <h3>Your account. Your workspaces.</h3><p>Sign in with Microsoft to load your dataflows, deployment stages, and migration history. Readiness is assessed automatically; migrations only run after your review and confirmation.</p>
        </div></div>
          {!tenant.config && <div role="alert" className="error-banner">Microsoft sign-in is not configured for this deployment. Ask the app administrator to configure the Entra application.</div>}
          {(validation || tenant.error) && <div role="alert" className="error-banner">{validation || tenant.error}</div>}
        </div>
        <footer className="dialog-footer"><button type="button" className="button" disabled={tenant.loading} onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" className="button primary" disabled={!prepared || tenant.loading}>{tenant.loading ? <LoaderCircle size={16} className="spin" /> : <LogIn size={16} />}{tenant.loading ? 'Connecting...' : 'Sign in with Microsoft'}<ArrowRight size={15} /></button>
        </footer>
      </form>
    </Modal>}
  </>;
}
