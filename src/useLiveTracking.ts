import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveRunRecord } from '../rayfin/functions/src/contracts';
import type { LiveBackend } from './liveClient';
import { upgradeOutcome } from './liveState';

export function useLiveTracking(backend: LiveBackend | null, records: LiveRunRecord[], remember: (run: LiveRunRecord) => void) {
  const scope = useMemo(() => ({ backend, active: true, requests: new Map<string, Promise<LiveRunRecord>>(),
    nextChecks: new Map<string, number>(), started: new Map<string, number>() }), [backend]);
  const [view, setView] = useState({ scope, checking: new Set<string>(), errors: new Map<string, string>() });
  const latest = useRef(records);
  useEffect(() => { latest.current = records; }, [records]);
  useEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  const update = useCallback((id: string, error?: string) => {
    if (!scope.active) return;
    setView(current => {
      const errors = new Map(current.scope === scope ? current.errors : []);
      if (error) errors.set(id, error); else errors.delete(id);
      return { scope, errors, checking: new Set(scope.requests.keys()) };
    });
  }, [scope]);
  const check = useCallback((run: LiveRunRecord, restart = true): Promise<LiveRunRecord> => {
    const pending = scope.requests.get(run.id);
    if (pending) return pending;
    const client = scope.backend;
    if (!client) return Promise.reject(new Error('Live tracking is not connected.'));
    if (restart || !scope.started.has(run.id)) scope.started.set(run.id, Date.now());
    let failure: string | undefined;
    const request = (async () => {
      try {
        const updated = await client.execute({ action: 'poll', requestId: run.id, workspaceId: run.workspaceId });
        if (updated.status === 'Needs reconciliation') failure = updated.error || 'The Microsoft outcome needs review. Refresh to retry tracking.';
        if (scope.active) remember(updated);
        return updated;
      } catch (reason) {
        failure = reason instanceof Error ? reason.message : String(reason);
        throw reason;
      } finally {
        scope.requests.delete(run.id);
        scope.nextChecks.set(run.id, Date.now() + 5000);
        update(run.id, failure);
      }
    })();
    scope.requests.set(run.id, request);
    update(run.id);
    return request;
  }, [scope, remember, update]);
  const errors = view.scope === scope ? view.errors : new Map<string, string>();
  const checking = view.scope === scope ? view.checking : new Set<string>();
  const key = records.filter(run => run.action === 'upgrade' && ['Running', 'Verifying', 'Needs reconciliation'].includes(run.status) && !errors.has(run.id))
    .map(run => run.id).sort().join(',');
  useEffect(() => {
    if (!backend || !key) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const ids = new Set(key.split(','));
    const tick = async () => {
      for (const run of latest.current.filter(item => ids.has(item.id))) {
        if (!active || !scope.active) return;
        const started = scope.started.get(run.id) ?? Date.now();
        scope.started.set(run.id, started);
        if (Date.now() - started >= 15 * 60_000) {
          update(run.id, 'Automatic tracking paused after 15 minutes. Refresh to continue; no upgrade will be resubmitted.');
          continue;
        }
        const next = Math.max(scope.nextChecks.get(run.id) ?? 0, Date.parse(upgradeOutcome(run)?.tracking?.nextPollAt ?? '') || 0);
        if (Date.now() < next) continue;
        try { await check(run, false); }
        catch { /* check exposes the error and pauses this request until an explicit retry. */ }
      }
      if (active) timer = setTimeout(() => void tick(), 1000);
    };
    timer = setTimeout(() => void tick(), 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [backend, key, check, scope, update]);
  const retry = useCallback(() => {
    scope.started.clear(); scope.nextChecks.clear();
    if (scope.active) setView({ scope, checking: new Set(scope.requests.keys()), errors: new Map() });
  }, [scope]);
  return { checking, errors, retry };
}
