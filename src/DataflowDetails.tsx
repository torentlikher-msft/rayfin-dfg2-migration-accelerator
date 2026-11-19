import { ArrowRight, CheckCircle2, CircleAlert, Info, Workflow } from 'lucide-react';
import { Badge, dateLabel, Modal } from './components';
import { generationLabel, type Dataflow, type Workspace } from './domain';

export default function DataflowDetails({ workspace, flow, converted, selectable, onClose, onSelect }: {
  workspace: Workspace; flow: Dataflow; converted: boolean; selectable: boolean;
  onClose(): void; onSelect(): void;
}) {
  const live = flow.origin === 'live';
  return <Modal drawer title="Dataflow details" onClose={onClose}>
    <div className="dialog-body">
      <div className="detail-title"><span className="detail-flow-icon"><Workflow size={26} /></span>
        <h2>{flow.name}</h2><p>{workspace.name}</p><Badge status={converted ? 'Converted' : flow.compatibility} />
      </div>
      {flow.description && <p>{flow.description}</p>}
      <h3 className="section-title">At a glance</h3>
      <dl className="details-grid">
        <dt>Source type</dt><dd>{flow.source}</dd>
        <dt>Generation</dt><dd>{generationLabel(flow)}</dd>
        <dt>Queries</dt><dd>{flow.entities ?? 'Not inspected'}</dd>
        <dt>Pipeline</dt><dd>{workspace.pipeline}</dd>
        <dt>Deployment stage</dt><dd>{workspace.stage}</dd>
        <dt>Capacity</dt><dd>{workspace.capacity}</dd>
        <dt>Last modified</dt><dd>{dateLabel(flow.modified)}</dd>
        {live && <><dt>Configured by</dt><dd>{flow.configuredBy || 'Not provided by API'}</dd></>}
        <dt>Workspace ID</dt><dd><code>{workspace.id}</code></dd>
        <dt>Source ID</dt><dd><code>{flow.id}</code></dd>
      </dl>
      <h3 className="section-title">Migration assessment</h3>
      {flow.issues.length ? flow.issues.map(issue =>
        <div key={issue} className={flow.compatibility === 'Blocked' ? 'callout danger-callout' : 'callout warning-callout'}>
          <CircleAlert size={18} /><span>{issue}</span>
        </div>) : <div className="callout success-callout"><CheckCircle2 size={18} /><span>No blockers in the sample assessment. Ready for a Gen2 save-as copy.</span></div>}
      <div className="detail-note"><Info size={17} /><p>{live
        ? 'Access to inventory is not proof of dataflow ownership or save-as permission. This connection cannot run migrations. Source types, query counts, and readiness require a separate assessment.'
        : 'A real migration creates a new artifact with a new ID. Downstream dependencies and incremental refresh need separate validation.'}</p></div>
    </div>
    <div className="dialog-footer"><button className="button" onClick={onClose}>Close</button>
      <button className="button primary" disabled={!selectable} onClick={onSelect}>{live ? 'Live migration not enabled' : 'Select for migration'}<ArrowRight size={15} /></button>
    </div>
  </Modal>;
}
