import { useCallback, useEffect, useRef, useState } from 'react';
import type { Board } from './types';
import { getBoard, getBoardVersion, putBoard, ConflictError } from './api';

export type LoadStatus = 'loading' | 'ready' | 'error';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const POLL_MS = 3000; // how often we check whether an agent (or another tab) changed the board

// Loads the single Maestro board and persists edits back to data.json.
// - Saves are debounced so rapid edits coalesce into one write (and one backup).
// - A version guard means a stale tab never clobbers work an agent landed on disk.
// - Background polling auto-reloads the board when it changes underneath us (while idle).
export function useBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [save, setSave] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const version = useRef<string | undefined>(undefined);
  const saveRef = useRef<SaveStatus>('idle');
  saveRef.current = save;

  const reload = useCallback(() => {
    setStatus('loading');
    getBoard()
      .then((b) => { setBoard(b); version.current = b.version; setStatus('ready'); setError(null); })
      .catch((e) => { setStatus('error'); setError(String(e.message || e)); });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Poll for out-of-band changes (an orchestrator landing a ticket, another tab saving).
  // Only auto-reload when we're not mid-edit, so we never drop the user's in-flight change.
  useEffect(() => {
    const iv = setInterval(() => {
      if (saveRef.current === 'saving' || timer.current) return;
      getBoardVersion()
        .then((v) => { if (version.current && v !== version.current) reload(); })
        .catch(() => { /* transient; try again next tick */ });
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [reload]);

  const persist = useCallback((b: Board) => {
    setSave('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      putBoard({ epics: b.epics, tickets: b.tickets, version: version.current })
        .then((v) => { version.current = v; setSave('saved'); setError(null); })
        .catch((e) => {
          if (e instanceof ConflictError && e.current) {
            // Disk wins: reload the latest and tell the user to reapply. Their agents' work
            // is never silently overwritten.
            setBoard(e.current);
            version.current = e.current.version;
          }
          setSave('error');
          setError(String(e.message || e));
        });
    }, 500);
  }, []);

  // Mutate the board immutably and persist (data.json only — archive is read-only here).
  const update = useCallback((fn: (b: Board) => Board) => {
    setBoard((prev) => {
      if (!prev) return prev;
      const next = fn(structuredClone(prev));
      persist(next);
      return next;
    });
  }, [persist]);

  return { board, status, save, error, reload, update };
}
