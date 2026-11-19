import { ArrowRight, BookOpen, Check, FlaskConical, Info, ShieldCheck } from 'lucide-react';
import { Modal } from './components';

export default function AppInformation({ view, live, count, storage, onClose }: {
  view: 'guide' | 'settings'; live: boolean; count: number; storage: string; onClose(): void;
}) {
  return <Modal title={view === 'guide' ? 'A familiar engine. A clearer workflow.' : 'Prototype configuration'} onClose={onClose}>
    <div className="dialog-body">
      {view === 'guide' ? <>
        <p className="modal-lead">A Rayfin-powered workbench inspired by the Fabric Toolbox Dataflow Gen2 migration accelerator.</p>
        <div className="guide-step"><span>1</span><div><h3>Connect & discover</h3><p>Choose Connect tenant and sign in with your own Microsoft account to read accessible workspace and dataflow metadata. Demo inventory stays available when disconnected.</p></div></div>
        <div className="guide-step"><span>2</span><div><h3>Inspect & assess</h3><p>Filter by workspace, name, or visible pipeline stage. Live compatibility starts as Not assessed; discovery does not verify ownership or permission to migrate.</p></div></div>
        <div className="guide-step"><span>3</span><div><h3>Explore conversion in demo mode</h3><p>Demo mode supports workspace selection, simulated conversion batches, and a persistent audit trail. Live inventory cannot enter the demo conversion engine.</p></div></div>
        <div className="callout"><Info size={18} /><span>No live notebooks or migrations are run. The README documents Entra setup, API permissions, inventory limitations, and the future server-side migration boundary.</span></div>
        <a className="resource-link" href="https://github.com/microsoft/fabric-toolbox/tree/main/accelerators/DFG2-migration-accelerator" target="_blank" rel="noreferrer">View the migration accelerator<ArrowRight size={16} /></a>
        <a className="resource-link" href="https://github.com/microsoft/rayfin" target="_blank" rel="noreferrer">Explore Microsoft Rayfin<ArrowRight size={16} /></a>
      </> : <>
        <div className="callout">{live ? <ShieldCheck size={18} /> : <FlaskConical size={18} />}<span><strong>{live ? 'Live inventory, read-only.' : 'Demo execution only.'}</strong> Live migration is not enabled. Switching audit persistence never enables real conversions.</span></div>
        <dl className="details-grid"><dt>Frontend</dt><dd>React + TypeScript</dd><dt>Platform</dt><dd>Microsoft Rayfin</dd>
          <dt>Identity</dt><dd>{live ? 'Delegated Microsoft Entra user account' : 'Demo operator'}</dd>
          <dt>Audit storage</dt><dd>{live ? 'Live audit source not configured' : storage}</dd>
          <dt>Inventory</dt><dd>{count} {live ? 'live' : 'sample'} dataflows</dd>
          <dt>Migration engine</dt><dd>{live ? 'Disabled' : 'Deterministic simulation'}</dd>
        </dl>
        <h3 className="section-title">Connect your tenant</h3><p>Use Connect tenant in the toolbar. Enter your Entra SPA tenant ID and client ID, then sign in as yourself. Expand the first-time setup instructions in that dialog for the exact redirect URI and read-only delegated scopes.</p>
        <h3 className="section-title">Rayfin demo audit storage</h3><p>Set <code>VITE_DATA_MODE=rayfin</code> and configure the Rayfin API URL and publishable key. Apply the included MigrationAttempt model to persist demo audit records through the typed Rayfin SDK.</p>
        <p className="detail-note"><BookOpen size={16} />The included anonymous Rayfin audit model is demo-only. Live inventory is fetched directly using the signed-in user's delegated Power BI token and is never written to that anonymous audit store.</p>
      </>}
    </div>
    <div className="dialog-footer"><button className="button primary" onClick={onClose}><Check size={16} />Got it</button></div>
  </Modal>;
}
