import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowRightLeft, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Clock3, Database, Eye, FolderClosed, History, Layers3, LayoutDashboard, LoaderCircle, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { apiAllowsUpgrade, type LiveRunRecord, type Readiness } from '../rayfin/functions/src/contracts';
import { Badge, Checkbox, dateLabel, downloadJson, Modal } from './components';
import { generationLabel, toggleGroup, type Dataflow, type Workspace } from './domain';
import TenantConnection from './TenantConnection';
import ThemeToggle from './ThemeToggle';
import StudioIcon from './StudioIcon';
import type { TenantInventoryController } from './useTenantInventory';
import { createLiveBackend, type LiveBackend } from './liveClient';
import { activeStatuses, assessmentState, flowKey, historyDataflows, upgradeOutcome, verifiedConversions } from './liveState';
import { useAutomaticAssessments } from './useAutomaticAssessments';
import { useLiveTracking } from './useLiveTracking';
import './live.css';

type Row = { workspace: Workspace; flow: Dataflow; readiness?: Readiness; assessment?: LiveRunRecord; state: string; key: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function HistoryDataflows({ run, records }: { run: LiveRunRecord; records: LiveRunRecord[] }) {
  const [open, setOpen] = useState(false);
  const items = historyDataflows(run, records);
  return <div className="history-dataflows">
    {items.length > 1 ? <button className="text-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>multiple dataflows...</button>
      : items.length === 1 ? <div title={items[0].id}>{items[0].name}</div> : <span className="muted">No dataflows recorded</span>}
    {open && <Modal drawer title="Dataflows" onClose={() => setOpen(false)}>
      <div className="dialog-body"><p>{items.length} dataflows in {run.workspaceName}</p><p className="live-request-id">Request: {run.id}</p>
        <ol className="history-dataflow-list">{items.map(item => <li key={item.id}><strong>{item.name}</strong><small className="live-request-id">{item.id}</small></li>)}</ol>
      </div>
      <footer className="dialog-footer"><button className="button" onClick={() => setOpen(false)}>Close</button></footer>
    </Modal>}
  </div>;
}

function TrackingIndicator({ run, checking, paused }: { run: LiveRunRecord; checking: boolean; paused: boolean }) {
  const active = run.action === 'upgrade' && activeStatuses.has(run.status);
  const label = checking ? 'Checking Microsoft' : paused ? 'Tracking paused' : run.status === 'Needs reconciliation' ? 'Needs review'
    : active ? 'Tracking automatically' : run.action === 'assess' ? run.status === 'Completed' ? 'Assessed' : 'Assessment failed'
      : ['Completed', 'Reconciled'].includes(run.status) ? 'Gen2 verified' : 'Finished';
  const warning = paused || ['Needs reconciliation', 'Failed', 'Partial'].includes(run.status);
  return <span className={`tracking-indicator ${warning ? 'tracking-warning' : ''}`} title={run.error || label}>{checking ? <LoaderCircle size={14} className="spin" /> : warning ? <CircleAlert size={14} /> : active ? <Clock3 size={14} /> : <CheckCircle2 size={14} />}{label}</span>;
}

export default function LiveWorkbench({ tenant }: { tenant: TenantInventoryController }) {
  const [backend, setBackend] = useState<LiveBackend | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [records, setRecords] = useState<LiveRunRecord[]>([]);
  const [cursor, setCursor] = useState('');
  const [page, setPage] = useState<'inventory' | 'history'>('inventory');
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('All stages');
  const [status, setStatus] = useState('All statuses');
  const [selected, setSelected] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [review, setReview] = useState(false);
  const [inPlace, setInPlace] = useState(false);
  const [attention, setAttention] = useState(false);
  const [details, setDetails] = useState<Row | null>(null);
  const [runDetails, setRunDetails] = useState<LiveRunRecord | null>(null);
  const alive = useRef(true);
  const locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const session = tenant.session;
    if (!session) return;
    let active = true;
    let connected: LiveBackend | undefined;
    setConnecting(true); setConnectionError(''); setBackend(null);
    void (async () => {
      try {
        const client = await createLiveBackend(session);
        if (!active) { client.dispose(); return; }
        connected = client;
        const history = await client.history();
        if (!active) return;
        setRecords(history.records); setCursor(history.cursor); setBackend(client);
      } catch (reason) {
        connected?.dispose(); connected = undefined;
        if (active) setConnectionError(`Live actions could not connect. ${message(reason)}`);
      } finally {
        if (active) setConnecting(false);
      }
    })();
    return () => { active = false; connected?.dispose(); connected = undefined; };
  }, [tenant.session, connectionAttempt]);

  const remember = useCallback((run: LiveRunRecord) => {
    if (!alive.current) return;
    setRecords(current => [run, ...current.filter(item => item.id !== run.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }, []);
  const automatic = useAutomaticAssessments(backend, tenant.result, remember);
  const tracking = useLiveTracking(backend, records, remember);
  const assessed = useMemo(() => assessmentState(records.filter(run => automatic.completed.get(run.workspaceId) === run.id)), [records, automatic.completed]);
  const converted = useMemo(() => verifiedConversions(records), [records]);
  const pending = new Set(records.filter(run => run.action === 'upgrade' && activeStatuses.has(run.status)).map(run => run.workspaceId));
  const workspaces = tenant.result?.workspaces ?? [];
  const rows: Row[] = workspaces.flatMap(workspace => workspace.flows.map(flow => {
    const key = flowKey(workspace.id, flow.id);
    const assessment = assessed.get(workspace.id);
    const readiness = automatic.completed.has(workspace.id) ? assessment?.items.get(flow.id) : undefined;
    return { workspace, flow, key, readiness, assessment: automatic.completed.has(workspace.id) ? assessment?.run : undefined,
      state: converted.has(key) ? 'Converted' : readiness?.status
        ?? (automatic.errors.has(workspace.id) ? 'Assessment failed' : backend && !automatic.completed.has(workspace.id) ? 'Assessing' : 'Not assessed') };
  }));
  const available = (row: Row) => !!backend && !pending.has(row.workspace.id) && row.state !== 'Converted'
    && !!row.readiness && apiAllowsUpgrade(row.readiness);
  const chosen = rows.filter(row => selected.has(row.key) && available(row));
  const visible = rows.filter(row => (stage === 'All stages' || row.workspace.stage === stage)
    && (status === 'All statuses' || row.state === status)
    && `${row.workspace.name} ${row.flow.name}`.toLowerCase().includes(search.trim().toLowerCase()));
  const canUpgrade = !automatic.assessing && chosen.length > 0 && chosen.every(row => row.readiness && apiAllowsUpgrade(row.readiness));
  const needsAttention = chosen.some(row => row.state === 'NeedsAttention');
  const activeRuns = records.filter(run => run.action === 'upgrade' && activeStatuses.has(run.status));
  const historyVisible = records.filter(run => `${run.workspaceName} ${run.id} ${run.action} ${run.status} ${run.resultJson} ${historyDataflows(run, records).map(item => item.name).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()));
  const viewedRun = records.find(run => run.id === runDetails?.id) ?? runDetails;
  const viewedOutcome = viewedRun ? upgradeOutcome(viewedRun) : null;
  const tableWorking = connecting || tenant.loading || (page === 'inventory' && automatic.assessing);
  const tableProgress = connecting ? 'Connecting live actions...' : tenant.loading ? 'Reading your inventory...'
    : page === 'inventory' && backend && automatic.total > 0
      ? automatic.assessing ? `Assessing ${automatic.current || 'workspaces'} with Microsoft (${automatic.completed.size + automatic.errors.size}/${automatic.total})...`
        : `Readiness checked for ${automatic.completed.size} of ${automatic.total} workspaces${automatic.errors.size ? `; ${automatic.errors.size} failed` : ''}.`
      : '';

  async function perform(label: string, action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(label); setError(''); setNotice('');
    try { await action(); }
    catch (reason) { if (alive.current) setError(`${message(reason)} Refresh history before retrying an interrupted submission.`); }
    finally { locked.current = false; if (alive.current) setBusy(''); }
  }
  async function readHistory(client: LiveBackend, append = false) {
    const result = await client.history(append ? cursor : '');
    if (!alive.current) return;
    setRecords(current => append ? [...current, ...result.records.filter(run => !current.some(item => item.id === run.id))]
      : [...result.records, ...current.filter(run => !result.records.some(item => item.id === run.id))]);
    setCursor(result.cursor);
  }
  function upgrade() {
    if (!backend || !canUpgrade || !inPlace || (needsAttention && !attention)) return;
    const batch = [...chosen]; setReview(false);
    void perform('Submitting in-place upgrades', async () => {
      const submitted = new Set<string>();
      let tracking = false;
      for (const workspaceId of [...new Set(batch.map(row => row.workspace.id))]) {
        const group = batch.filter(row => row.workspace.id === workspaceId);
        for (let offset = 0; offset < group.length; offset += 50) {
          const part = group.slice(offset, offset + 50);
          const run = await backend.execute({ action: 'upgrade', requestId: crypto.randomUUID(), workspaceId,
            ids: part.map(row => row.flow.id), assessmentId: part[0].assessment!.id,
            acknowledgeInPlace: true, acknowledgeAttention: attention });
          remember(run);
          part.forEach(row => submitted.add(row.key));
          setSelected(current => new Set([...current].filter(key => !submitted.has(key))));
          if (run.status !== 'Completed') {
            setPage('history');
            if (['Running', 'Verifying'].includes(run.status)) {
              tracking = true;
              break;
            }
            throw new Error(run.error || `Batch is ${run.status}. Review its per-dataflow outcomes before continuing.`);
          }
          if (!alive.current) return;
        }
      }
      setPage('history');
      setNotice(tracking ? `Submitted ${submitted.size} of ${batch.length} reviewed dataflows. Tracking continues automatically while connected. Any remaining selected items were not submitted; review them after the active workspace batch finishes.`
        : 'Upgrade results saved. Successful items were verified through the Gen2 API with their original IDs.');
    });
  }
  const select = (keys: string[]) => setSelected(current => toggleGroup(current, keys));

  return <div className="app live-workbench">
    <header className="fabric-bar"><div className="fabric-brand"><Layers3 size={20} /><span>Microsoft Fabric</span><span className="bar-divider" /><span className="subtle">Dataflow Migration Studio</span></div><div className="fabric-actions"><span className="preview-label">{tenant.session ? 'LIVE TENANT' : tenant.loading ? 'CONNECTING' : 'NOT CONNECTED'}</span><span className="avatar" title={tenant.session?.account.username}>{tenant.session ? (tenant.session.account.name || 'U').slice(0, 2).toUpperCase() : '--'}</span></div></header>
    <aside className="sidebar"><div className="app-brand"><span className="brand-mark"><StudioIcon /></span><div><strong>Dataflow Migration Studio</strong><small>Dataflow Gen2 accelerator</small></div></div><div className="nav-label">WORKSPACE MIGRATION</div><nav aria-label="Main navigation"><button className={`nav-item ${page === 'inventory' ? 'active' : ''}`} onClick={() => { setPage('inventory'); setSearch(''); }}><LayoutDashboard size={18} />Migration workbench</button><button className={`nav-item ${page === 'history' ? 'active' : ''}`} onClick={() => { setPage('history'); setSearch(''); }}><History size={18} />Migration history<span className="nav-count">{records.filter(run => run.action === 'upgrade').length}</span></button></nav><div className="sidebar-bottom"><div className="powered"><span className="rayfin-dot"><Layers3 size={18} /></span><div><strong>Built with Rayfin</strong><small>Authenticated execution &amp; audit</small></div></div></div></aside>
    <div className="main-shell"><div className="toolbar"><div className="breadcrumb"><span>Fabric</span><ChevronRight size={13} /><span>Dataflow migration</span><ChevronRight size={13} /><strong>{page === 'inventory' ? 'Workbench' : 'History'}</strong></div><div className="toolbar-actions"><TenantConnection tenant={tenant} disabled={!!busy} /><button className="button" disabled={!tenant.session || !!busy || tenant.loading || automatic.assessing} onClick={() => void perform('Refreshing', async () => { tracking.retry(); if (backend) await readHistory(backend); await tenant.refresh(); })}><RefreshCw size={15} />Refresh</button><ThemeToggle /></div></div>
      <main><div className="page-heading"><div><div className="eyebrow">GEN1 <ArrowRight size={12} /> GEN2</div><h1>{page === 'inventory' ? 'A new generation of dataflows.' : 'Every migration. One clear trail.'}</h1><p>{page === 'inventory' ? 'Discover your tenant. Automatic Microsoft assessments. Upgrade with confidence.' : 'Durable, account-scoped assessments, Microsoft outcomes, and follow-up actions.'}</p></div><div className="page-actions">{tenant.session && !backend && connectionError ? <button className="button" disabled={!!busy || connecting} onClick={() => setConnectionAttempt(attempt => attempt + 1)}>Retry live connection</button> : backend && page === 'history' && <button className="button" disabled={!records.length} onClick={() => downloadJson(records, 'live-dataflow-audit.json')}><ArrowDownToLine size={16} />Export audit</button>}</div></div>
        <div className="demo-banner live-banner"><ShieldCheck size={18} /><div><strong>{tenant.session ? `Signed in as ${tenant.session.account.username}` : 'Connect your Microsoft account'}</strong><p>{backend ? 'Microsoft API readiness and in-place upgrades. Successful upgrades retain the ID and replace Gen1 with Gen2.' : connecting ? 'Connecting authenticated live actions automatically using your Microsoft sign-in. No second sign-in is required.' : tenant.session ? 'Live actions connect automatically after tenant sign-in. Reconnect if Microsoft requires renewed consent; retry a temporary backend error.' : 'Sign in to load your inventory, deployment stages, and migration history.'}</p>{tenant.result && <small>{tenant.result.accessibleWorkspaces} accessible workspaces scanned · {tenant.result.skippedGen2} confirmed Gen2 items excluded · Updated {dateLabel(tenant.result.retrievedAt)}</small>}</div></div>
        {(error || tenant.error || connectionError) && <div role="alert" className="error-banner"><CircleAlert size={18} /><span>{[error, tenant.error && `${tenant.error} No sample inventory is substituted.`, connectionError].filter(Boolean).join(' ')}</span></div>}
        {automatic.errors.size > 0 && <div role="alert" className="error-banner"><CircleAlert size={18} /><div><strong>Some automatic assessments failed. Refresh to retry.</strong>{[...automatic.errors].map(([workspaceId, detail]) => <p key={workspaceId}>{detail}</p>)}</div></div>}
        {tracking.errors.size > 0 && <div role="alert" className="error-banner"><CircleAlert size={18} /><div><strong>Automatic tracking paused. Refresh to retry without resubmitting.</strong>{[...tracking.errors].map(([id, detail]) => <p key={id}>{id}: {detail}</p>)}</div></div>}
        {notice && <div role="status" className="notice-banner"><CheckCircle2 size={18} /><span>{notice}</span></div>}
        {busy && <div className="notice-banner" aria-live="polite"><LoaderCircle className="spin" size={18} />{busy}...</div>}
        <section className="metrics" aria-label="Migration overview">{[
          ['Dataflows discovered', rows.length, `across ${workspaces.length} workspaces`],
          ['ReadyToMigrate', rows.filter(row => row.state === 'ReadyToMigrate').length, 'Exact Microsoft API verdict'],
          ['NeedsAttention', rows.filter(row => row.state === 'NeedsAttention').length, 'Review Microsoft reasons'],
          ['Verified upgrades', converted.size, 'Same-ID Gen2 readback confirmed'],
        ].map(([label, count, note]) => <div className="metric" key={label}><div className="metric-heading">{label}<span className="metric-icon teal"><Layers3 size={17} /></span></div><div className="metric-number">{tenant.result ? count : '—'}</div><div className="metric-foot">{tenant.result ? note : 'Awaiting your inventory'}</div></div>)}</section>
        {activeRuns.length > 0 && <div className="demo-banner"><History size={18} /><span><strong>{activeRuns.length} upgrade batch(es) need tracking or reconciliation.</strong> Running operations are checked automatically while connected. Reloading never resubmits an upgrade.</span><button onClick={() => setPage('history')}>View history<ArrowRight size={14} /></button></div>}
        <section className={`workbench-card ${page === 'inventory' ? 'live-inventory-card' : 'live-history-card'}`}><div className="inventory-controls"><div className="card-tabs"><button className={`tab ${page === 'inventory' ? 'active' : ''}`} onClick={() => { setPage('inventory'); setSearch(''); }}><FolderClosed size={16} />Workspace inventory<span>{tenant.result ? rows.length : '—'}</span></button><button className={`tab ${page === 'history' ? 'active' : ''}`} onClick={() => { setPage('history'); setSearch(''); }}><History size={16} />Migration history</button><span className="card-tabs-note"><ShieldCheck size={14} />Native in-place upgrade</span></div>
          <div className="inventory-heading"><div><h2>{page === 'inventory' ? 'Your workspaces' : 'Assessments & upgrades'}</h2><p>{page === 'inventory' ? 'Workspace selection includes ReadyToMigrate only. Select NeedsAttention items individually.' : 'Actual Microsoft responses are retained. Assessment and upgrade records are separate.'}</p>{tableProgress && <small className="assessment-progress" role="status" aria-label="Table progress">{tableWorking && <LoaderCircle size={14} className="spin" aria-hidden="true" />}<span>{tableProgress}</span></small>}</div>{page === 'inventory' && <button className="button primary migrate-inventory" disabled={!canUpgrade || !!busy} onClick={() => { setInPlace(false); setAttention(false); setReview(true); }}><ArrowRightLeft size={16} />Migrate selected{chosen.length > 0 && <span className="button-count">{chosen.length}</span>}</button>}</div>
          <div className="filter-bar">
            <div className="search-box"><Search size={16} /><input aria-label={page === 'inventory' ? 'Search dataflows' : 'Search migration history'} placeholder={page === 'inventory' ? 'Search dataflows or workspaces...' : 'Search history...'} value={search} onChange={event => { setSearch(event.target.value); setSelected(new Set()); }} /></div>
            {page === 'inventory' && <>
              <select aria-label="Deployment pipeline stage" value={stage} onChange={event => { setStage(event.target.value); setSelected(new Set()); }}>{['All stages', ...new Set(workspaces.map(workspace => workspace.stage))].map(value => <option key={value}>{value}</option>)}</select>
              <select aria-label="Migration compatibility status" value={status} onChange={event => { setStatus(event.target.value); setSelected(new Set()); }}>{[...new Set(['All statuses', 'Not assessed', 'ReadyToMigrate', 'NeedsAttention', 'UpgradeUnavailable', 'Unknown', 'Converted', ...rows.map(row => row.state)])].map(value => <option key={value}>{value}</option>)}</select>
            </>}
          </div>
          {page === 'inventory' && chosen.length > 0 && <div className="selection-bar"><span><strong>{chosen.length} selected</strong>{automatic.assessing && ' · Waiting for automatic assessments to finish.'}</span><button className="text-button" onClick={() => setSelected(new Set())}>Clear selection</button></div>}
          </div>
          {page === 'inventory' ? <div className="inventory-frame" role="region" aria-label="Workspace dataflows" tabIndex={0}>
            {workspaces.filter(workspace => visible.some(row => row.workspace.id === workspace.id)).map(workspace => {
              const items = visible.filter(row => row.workspace.id === workspace.id);
              const keys = items.filter(row => available(row) && row.state === 'ReadyToMigrate').map(row => row.key);
              const count = keys.filter(key => selected.has(key)).length;
              const ready = rows.filter(row => row.workspace.id === workspace.id && row.state === 'ReadyToMigrate').length;
              const blockingRun = activeRuns.find(run => run.workspaceId === workspace.id);
              return <div className="workspace-group" key={workspace.id}><div className="workspace-header"><Checkbox label={`Select workspace ${workspace.name}`} disabled={!keys.length || !!busy} checked={keys.length > 0 && count === keys.length} mixed={count > 0 && count < keys.length} onChange={() => select(keys)} /><button className="workspace-toggle" aria-expanded={expanded.has(workspace.id)} onClick={() => setExpanded(current => toggleGroup(current, [workspace.id]))}>{expanded.has(workspace.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<span className="workspace-icon"><FolderClosed size={18} /></span><strong>{workspace.name}</strong><span className="workspace-totals"><span className="workspace-count">{workspace.flows.length} dataflows</span><span className="workspace-ready" title="Exact Microsoft ReadyToMigrate status, excluding converted items">{automatic.completed.has(workspace.id) ? `${ready} ready to migrate` : automatic.errors.has(workspace.id) ? 'Assessment failed' : 'Assessing readiness...'}</span></span></button><span className="stage-pill">{workspace.stage}</span>{automatic.completed.has(workspace.id) && assessed.get(workspace.id) && <small className="muted">Assessed {dateLabel(assessed.get(workspace.id)!.run.completedAt)}</small>}</div>
                {blockingRun && <div className="workspace-lock"><CircleAlert size={16} /><span>Selection is locked by upgrade request <button className="text-button" onClick={() => setRunDetails(blockingRun)}>{blockingRun.id}</button> ({blockingRun.status}).</span><TrackingIndicator run={blockingRun} checking={tracking.checking.has(blockingRun.id)} paused={tracking.errors.has(blockingRun.id)} /></div>}
                {expanded.has(workspace.id) && <div className="table-scroll"><table className="inventory-table"><thead><tr><th className="check-cell" /><th>Dataflow name</th><th>Readiness</th><th>API reasons</th><th /></tr></thead><tbody>{items.map(row => <tr key={row.key} className={selected.has(row.key) ? 'selected-row' : ''}><td className="check-cell"><Checkbox label={`Select ${row.flow.name}`} disabled={!available(row) || !!busy} checked={selected.has(row.key)} onChange={() => select([row.key])} /></td><td><button className="flow-name" onClick={() => setDetails(row)}><span className="dataflow-icon"><Database size={16} /></span><span><strong>{row.flow.name}</strong><small>{row.state === 'Converted' ? 'Dataflow Gen2' : row.readiness ? 'Dataflow Gen1' : generationLabel(row.flow)}</small></span></button></td><td><Badge status={row.state} /></td><td><span className="muted">{row.readiness?.reasons?.map(reason => reason.message).join(' · ') || (row.readiness ? 'No reasons returned' : row.state === 'Assessing' ? 'Checking with Microsoft...' : row.state === 'Assessment failed' ? 'Refresh inventory to retry' : 'No readiness result returned')}</span></td><td><button className="icon-button" aria-label={`View ${row.flow.name} details`} onClick={() => setDetails(row)}><Eye size={16} /></button></td></tr>)}</tbody></table></div>}</div>;
            })}
            {!visible.length && <div className="empty-state"><Database size={34} /><h3>{tenant.loading ? 'Reading your inventory...' : !tenant.session ? 'Connect your Microsoft account' : !tenant.result ? 'Live inventory is not loaded' : 'No matching dataflows'}</h3><p>{tenant.loading ? 'Reading accessible workspaces under your account.' : !tenant.session ? 'Your dataflows appear here after you sign in.' : 'Refresh inventory or adjust the search and filters. No sample data is substituted.'}</p></div>}
          </div> : !backend ? <div className="empty-state"><History size={34} /><h3>{connecting ? 'Connecting live history...' : 'Live history is not connected'}</h3><p>Sign in to view your account-scoped migration history.</p></div> : <>
            <div className="history-frame" role="region" aria-label="Migration history records" tabIndex={0}>
              <table className="inventory-table history-table"><thead><tr><th>Workspace</th><th>Dataflow name</th><th>Request ID</th><th>Action</th><th>Outcome</th><th>Started</th><th>Tracking</th><th>Details</th></tr></thead><tbody>{historyVisible.map(run => <tr key={run.id}>
                <td><button className="text-button" onClick={() => setRunDetails(run)}>{run.workspaceName}</button></td>
                <td><HistoryDataflows run={run} records={records} /></td>
                <td className="history-request-id">{run.id}</td>
                <td>{run.action === 'assess' ? 'API assessment' : 'In-place upgrade'}</td><td><Badge status={run.status} /></td><td>{dateLabel(run.startedAt)}</td>
                <td><TrackingIndicator run={run} checking={tracking.checking.has(run.id)} paused={tracking.errors.has(run.id)} /></td>
                <td><button className="text-button" onClick={() => setRunDetails(run)}>View API results</button></td>
              </tr>)}</tbody></table>
              {!records.length && <div className="empty-state"><History size={34} /><h3>No live runs yet</h3><p>Automatic assessments create durable records as inventory loads.</p></div>}
              {cursor && <div className="live-history-more"><button className="button" disabled={!!busy} onClick={() => void perform('Loading older history', () => readHistory(backend, true))}>Load older records</button><small>Only names retained in loaded audit evidence are shown.</small></div>}
            </div>
          </>}
          <div className="table-footer"><span>{page === 'inventory' ? `${visible.length} dataflows shown` : `${records.length} audit records loaded`}</span><span>Microsoft API verdicts · no custom compatibility scoring</span></div>
        </section>
      </main>
    </div>
    {details && <Modal title={details.flow.name} onClose={() => setDetails(null)} drawer><div className="dialog-body"><Badge status={details.state} /><dl className="detail-list"><dt>Workspace</dt><dd>{details.workspace.name}</dd><dt>Dataflow ID</dt><dd>{details.flow.id}</dd><dt>Deployment pipeline</dt><dd>{details.workspace.pipeline}</dd><dt>Stage</dt><dd>{details.workspace.stage}</dd><dt>Assessment source</dt><dd>Microsoft Fabric gen1UpgradeReadinessResults</dd><dt>Assessed at</dt><dd>{details.assessment ? dateLabel(details.assessment.completedAt) : 'Not assessed'}</dd></dl>{details.readiness?.reasons?.map((reason, index) => <div className="review-warning" key={index}><strong>{reason.code} · {reason.status}</strong><p>{reason.message}</p></div>)}{!details.readiness && <p>No compatibility conclusion has been inferred from inventory metadata.</p>}</div><footer className="dialog-footer"><button className="button" onClick={() => setDetails(null)}>Close</button>{!backend && <button className="button primary" disabled>Live migration not enabled</button>}</footer></Modal>}
    {review && <Modal title="Review in-place upgrade" onClose={() => setReview(false)}><div className="dialog-body"><div className="review-warning"><CircleAlert size={18} /><p><strong>This replaces Gen1 with Gen2 in place.</strong> The dataflow ID and workspace are retained. This is not a copy; a separate Gen1 original is not preserved.</p></div><p>{chosen.length} dataflows in {new Set(chosen.map(row => row.workspace.id)).size} workspace(s). Microsoft readiness is checked again immediately before submission. Batches contain at most 50 items.</p><ul>{chosen.map(row => <li key={row.key}><strong>{row.flow.name}</strong> · {row.workspace.name} · {row.state}{row.readiness?.reasons?.map((reason, index) => <p key={index}>{reason.code}: {reason.message}</p>)}</li>)}</ul><label className="checkbox-label"><input type="checkbox" checked={inPlace} onChange={event => setInPlace(event.target.checked)} />I understand this replaces Gen1 in place, rather than creating a copy.</label>{needsAttention && <label className="checkbox-label"><input type="checkbox" checked={attention} onChange={event => setAttention(event.target.checked)} />I have reviewed the Microsoft NeedsAttention reasons and required follow-ups.</label>}</div><footer className="dialog-footer"><button className="button" onClick={() => setReview(false)}>Cancel</button><button className="button primary" disabled={!inPlace || (needsAttention && !attention) || !!busy} onClick={upgrade}>Upgrade in place</button></footer></Modal>}
    {viewedRun && <Modal title={viewedRun.action === 'assess' ? 'Microsoft readiness assessment' : 'Microsoft upgrade results'} onClose={() => setRunDetails(null)} drawer><div className="dialog-body"><Badge status={viewedRun.status} /><p>{viewedRun.workspaceName} · {dateLabel(viewedRun.startedAt)}</p><p className="live-request-id">Request: {viewedRun.id}</p>{viewedRun.error && <div className="error-banner">{viewedRun.error}</div>}{viewedOutcome?.reconciliation && <div className="review-warning"><strong>Gen2 readback reconciliation</strong><p>The saved Microsoft operation returned HTTP 404. Only the exact selected IDs confirmed by the Gen2 API count as verified. The original migration result and any required follow-up actions could not be recovered; they have not been fabricated. No upgrade was resubmitted.</p><p>Verified {viewedOutcome.reconciliation.items.length} of {viewedOutcome.reconciliation.items.length + viewedOutcome.reconciliation.unverifiedIds.length} selected IDs at {dateLabel(viewedOutcome.reconciliation.checkedAt)}.</p>{viewedOutcome.reconciliation.items.map(item => <p key={item.id}>{item.displayName} · {item.id}</p>)}</div>}{viewedOutcome?.apiResult?.migrations.map(migration => <div className="live-result-item" key={migration.dataflowId}><strong>{migration.dataflowName}</strong><Badge status={migration.migrationStatus} /><p>{migration.dataflowId}</p>{migration.migrationError && <p>{migration.migrationError.errorCode}: {migration.migrationError.message}</p>}{migration.requiredActions?.map((action, index) => <p key={index}>{action.code} · {action.status}: {action.message}</p>)}</div>)}<h3>{viewedOutcome && !viewedOutcome.apiResult ? 'Stored tracking / verification evidence' : 'Complete API response'}</h3><pre className="live-api-json">{viewedRun.resultJson ? JSON.stringify(JSON.parse(viewedRun.resultJson), null, 2) : 'No API result has been recorded yet.'}</pre>{viewedRun.operationUrl && <p className="live-request-id">Operation: {viewedRun.operationUrl}</p>}</div><footer className="dialog-footer"><button className="button" onClick={() => downloadJson(viewedRun, `live-run-${viewedRun.id}.json`)}>Export record</button><button className="button" onClick={() => setRunDetails(null)}>Close</button></footer></Modal>}
  </div>;
}
