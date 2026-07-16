import { useCallback, useEffect, useRef, useState } from 'react';
import type { Board } from './types';
import { getBoard, putBoard } from './api';

export type LoadStatus = 'loading' | 'ready' | 'error';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// Loads the single Maestro board and persists edits back to data.json.
// Saves are debounced so rapid edits coalesce into one write (and one backup).
export function useBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [save, setSave] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => {
    setStatus('loading');
    getBoard()
      .then((b) => { setBoard(b); setStatus('ready'); setError(null); })
      .catch((e) => { setStatus('error'); setError(String(e.message || e)); });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const persist = useCallback((b: Board) => {
    setSave('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      putBoard({ epics: b.epics, tickets: b.tickets })
        .then(() => { setSave('saved'); setError(null); })
        .catch((e) => { setSave('error'); setError(String(e.message || e)); });
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
