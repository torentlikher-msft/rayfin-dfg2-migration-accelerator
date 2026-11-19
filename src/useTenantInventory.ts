import { useCallback, useEffect, useRef, useState } from 'react';
import { discoverInventory, type InventoryResult } from './tenantInventory';
import { restoreTenant, savedConnection, signInFailureMessage, signInTenant, type ConnectionConfig, type TenantSession } from './tenantAuth';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useTenantInventory() {
  const [session, setSession] = useState<TenantSession | null>(null);
  const [config, setConfig] = useState<ConnectionConfig | null>(null);
  const [result, setResult] = useState<InventoryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sessionRef = useRef<TenantSession | null>(null);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const read = useCallback(async (current: TenantSession, version: number) => {
    const abort = new AbortController();
    controller.current = abort;
    setResult(null); setLoading(true); setError('');
    try {
      const inventory = await discoverInventory(current, abort.signal);
      if (request.current !== version) return false;
      setResult(inventory);
      return true;
    } catch (reason) {
      abort.abort();
      if (request.current === version) setError(`Live inventory could not be loaded. ${message(reason)}`);
      return false;
    } finally {
      if (request.current === version) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function restore() {
      try {
        const saved = savedConnection();
        if (!saved) return;
        if (active) setConfig(saved);
        const restored = await restoreTenant(saved);
        if (!active || request.current !== 0 || !restored) return;
        sessionRef.current = restored;
        setSession(restored);
        await read(restored, ++request.current);
      } catch (reason) {
        if (active && request.current === 0) setError(`Could not restore Microsoft sign-in. ${message(reason)}`);
      }
    }
    void restore();
    return () => { active = false; controller.current?.abort(); };
  }, [read]);

  const connect = useCallback(async (input: ConnectionConfig) => {
    const version = ++request.current;
    controller.current?.abort();
    sessionRef.current = null;
    setSession(null); setResult(null); setError(''); setLoading(true);
    try {
      const signedIn = await signInTenant(input);
      if (version !== request.current) return false;
      sessionRef.current = signedIn;
      setSession(signedIn); setConfig(signedIn.config);
      void read(signedIn, version);
      return true;
    } catch (reason) {
      if (request.current === version) {
        setError(`Microsoft sign-in failed. ${signInFailureMessage(reason)}`);
        setLoading(false);
      }
      return false;
    }
  }, [read]);

  const refresh = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) { setError('Connect your Microsoft account before refreshing live inventory.'); return; }
    controller.current?.abort();
    await read(current, ++request.current);
  }, [read]);

  const disconnect = useCallback(async () => {
    ++request.current;
    controller.current?.abort();
    const previous = sessionRef.current;
    sessionRef.current = null;
    setSession(null); setResult(null); setLoading(false); setError('');
    try { await previous?.disconnect(); }
    catch (reason) { setError(`Disconnected from inventory, but the app token cache could not be cleared. ${message(reason)}`); }
  }, []);

  return {
    isLive: !!session, session, config, result, loading, error,
    identity: session ? `${session.account.tenantId}:${session.account.homeAccountId}` : 'signed-out',
    connect, refresh, disconnect,
  };
}

export type TenantInventoryController = ReturnType<typeof useTenantInventory>;
