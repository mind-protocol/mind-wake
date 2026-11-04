import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { demoSnapshot, disconnectedSnapshot } from '../data/demo.ts';
import { fetchLiveSnapshot } from '../data/logic.ts';
import type { DataMode, Draft, ReadState, Snapshot } from '../data/types.ts';

type State = { mode: DataMode; setMode: (mode: DataMode) => void; snapshot: Snapshot;
  status: ReadState; error: string | null; reload: () => void;
  drafts: Draft[]; keepDraft: (draft: Omit<Draft, 'id' | 'savedAt'>) => void };
const AppContext = createContext<State | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [mode, selectMode] = useState<DataMode>('demo');
  const [remote, setRemote] = useState<{ snapshot: Snapshot; status: ReadState; error: string | null }>({ snapshot: disconnectedSnapshot, status: 'loading', error: null });
  const [revision, setRevision] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const setMode = useCallback((next: DataMode) => {
    selectMode(next);
    if (next === 'live') setRemote({ snapshot: disconnectedSnapshot, status: 'loading', error: null });
  }, []);
  const reload = useCallback(() => { setRemote({ snapshot: disconnectedSnapshot, status: 'loading', error: null }); setRevision(value => value + 1); }, []);
  useEffect(() => {
    if (mode === 'demo') return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 12000);
    fetchLiveSnapshot(process.env.EXPO_PUBLIC_MIND_API_URL, { signal: controller.signal })
      .then(value => { if (active) setRemote({ snapshot: value, status: 'ready', error: null }); })
      .catch(reason => { if (active) setRemote({ snapshot: disconnectedSnapshot, status: 'unavailable', error: controller.signal.aborted ? 'La lecture a pris trop de temps. Ton solde reste inconnu.' : reason instanceof Error ? reason.message : 'La connexion est indisponible.' }); })
      .finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [mode, revision]);
  const keepDraft = useCallback((draft: Omit<Draft, 'id' | 'savedAt'>) => {
    setDrafts(previous => [{ ...draft, id: `draft-${Date.now()}`, savedAt: new Date().toISOString() }, ...previous]);
  }, []);
  return <AppContext.Provider value={{ mode, setMode, snapshot: mode === 'demo' ? demoSnapshot : remote.snapshot,
    status: mode === 'demo' ? 'ready' : remote.status, error: mode === 'demo' ? null : remote.error,
    reload, drafts, keepDraft }}>{children}</AppContext.Provider>;
}
export function useMind() { const value = useContext(AppContext); if (!value) throw Error('AppStateProvider manquant'); return value; }
