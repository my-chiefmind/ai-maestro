import { useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Card, Checkbox, Chip, Container, Dialog, DialogActions, DialogContent,
  DialogTitle, Divider, Drawer, IconButton, ListItemText, MenuItem, OutlinedInput, Select,
  TextField, Typography, useTheme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { Board, BoardEpic, BoardTicket, ProjectConfig } from './types';
import { useBoard } from './useBoard';
import { useConfig } from './useConfig';
import { usePlanScope } from './usePlanScope';
import { getSpec, putSpec } from './api';
import {
  BOARD_STATUSES, PRIORITIES, MODELS, epicName, isReady, isGated, planLabel,
  planStepsFor, nextTicketId, nextEpicId, allTicketRefs,
} from './boardLib';

const SAVE_LABEL: Record<string, string> = { saving: 'saving…', saved: 'saved ✓', error: 'save error', idle: '' };
const PRANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function useAccents() {
  const p = useTheme().palette;
  const statusColor = (s: string): string => ({
    todo: p.primary.main, 'in-progress': p.info.main, review: p.warning.main,
    blocked: p.error.main, done: p.success.main, backlog: p.text.secondary,
  } as Record<string, string>)[s] || p.text.secondary;
  const priorityColor = (pr?: string): string =>
    ({ P0: p.error.main, P1: p.warning.main } as Record<string, string>)[pr || ''] || p.text.secondary;
  const modelColor = (m?: string): string =>
    ({ opus: p.secondary.main, sonnet: p.primary.main, haiku: p.text.secondary } as Record<string, string>)[m || ''] || p.text.secondary;
  return { statusColor, priorityColor, modelColor };
}

function Badge({ label, color, strong }: { label: string; color: string; strong?: boolean }) {
  return (
    <Box component="span" sx={{
      px: 0.9, py: 0.3, borderRadius: 999, bgcolor: alpha(color, 0.15), color,
      fontSize: 10.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase',
      lineHeight: 1.6, border: strong ? `1px solid ${alpha(color, 0.4)}` : 'none', whiteSpace: 'nowrap',
    }}>{label}</Box>
  );
}

function EpicItem({ active, onClick, name, count, no }: { active: boolean; onClick: () => void; name: string; count: number; no?: number }) {
  return (
    <Box component="button" onClick={onClick}
      sx={{ display: 'flex', gap: 1, width: '100%', textAlign: 'left', border: 0, borderTop: '1px solid', borderColor: 'divider',
        bgcolor: active ? 'action.selected' : 'transparent', color: active ? 'text.primary' : 'text.secondary',
        px: 1.6, py: 1.1, cursor: 'pointer', alignItems: 'flex-start',
        '&:hover': { bgcolor: 'action.hover', color: 'text.primary' } }}>
      <Box sx={{ width: 7, height: 7, mt: 0.7, borderRadius: '50%', bgcolor: active ? 'primary.main' : 'divider', flex: '0 0 auto' }} />
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>
          {no != null && <Box component="span" sx={{ color: 'primary.main', fontWeight: 700, fontFamily: 'monospace', mr: 0.6 }}>E{no}</Box>}{name}
        </Box>
        <Box sx={{ fontSize: 11, color: 'text.disabled' }}>{count} ticket{count === 1 ? '' : 's'}</Box>
      </Box>
    </Box>
  );
}

export default function BoardConsole() {
  const { board, status, save, error, reload, update } = useBoard();
  const config = useConfig();

  if (status === 'loading') return <Container sx={{ py: 8 }}><Typography>Loading board…</Typography></Container>;
  if (status === 'error' || !board) {
    return (
      <Container sx={{ py: 8 }}>
        <Typography variant="h6">Could not load the board.</Typography>
        <Typography color="text.secondary" sx={{ my: 1 }}>{error}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Start the data service with <code>npm run server</code> and make sure a
          <code> board/data.json</code> exists.
        </Typography>
        <Button variant="outlined" onClick={reload}>Retry</Button>
      </Container>
    );
  }
  return <SingleBoard board={board} save={save} error={error} reload={reload} update={update} config={config} />;
}

type Props = {
  board: Board; save: string; error: string | null; config: ProjectConfig | null;
  reload: () => void; update: (fn: (b: Board) => Board) => void;
};

function SingleBoard({ board, save, error, reload, update, config }: Props) {
  const { statusColor, priorityColor, modelColor } = useAccents();
  const [f, setF] = useState({ status: '', priority: '', area: '', q: '', focus: 'active', epic: '', initiative: '' });
  const [sel, setSel] = useState<string | null>(null);
  const [epicsOpen, setEpicsOpen] = useState(false);
  const planScope = usePlanScope();
  const [view, setView] = useState<'list' | 'kanban'>('list');

  const areas = useMemo(() => [...new Set(
    [...(config?.areas || []), ...board.tickets, ...board.archived].map((t) => typeof t === 'string' ? t : t.area).filter(Boolean),
  )].sort() as string[], [board, config]);

  const stats = useMemo(() => ({
    active: board.tickets.length,
    p0: board.tickets.filter((t) => t.priority === 'P0').length,
    ready: board.tickets.filter((t) => isReady(t, board)).length,
    blocked: board.tickets.filter((t) => t.status === 'blocked').length,
    gated: board.tickets.filter(isGated).length,
    done: board.archived.length,
  }), [board]);

  const sourceFor = (): BoardTicket[] => {
    if (f.focus === 'archive') return board.archived;
    if (f.focus === 'all') return [...board.tickets, ...board.archived];
    if (f.focus === 'ready') return board.tickets.filter((t) => isReady(t, board));
    if (f.focus === 'gated') return board.tickets.filter(isGated);
    if (f.focus === 'blocked') return board.tickets.filter((t) => t.status === 'blocked');
    return board.tickets;
  };
  // A ticket's initiative is DERIVED through its epic — it is never stored on the ticket, so
  // the filter resolves it the same way every other reader does.
  const initiativeOfTicket = (t: BoardTicket) =>
    [...board.epics, ...board.archivedEpics].find((e) => e.id === t.epicId)?.initiativeId ?? '';
  const matches = (t: BoardTicket) =>
    (!f.status || t.status === f.status) &&
    (!f.priority || t.priority === f.priority) &&
    (!f.area || t.area === f.area) &&
    (!f.epic || t.epicId === f.epic) &&
    (!f.initiative || initiativeOfTicket(t) === f.initiative) &&
    (!f.q || `${t.id} ${t.name} ${t.desc || ''} ${t.area || ''} ${planLabel(t)} ${epicName(board, t.epicId)}`
      .toLowerCase().includes(f.q.toLowerCase()));

  const groups = useMemo(() => {
    const tickets = sourceFor().filter(matches);
    const g = new Map<string, BoardTicket[]>();
    for (const t of tickets) {
      const k = t.epicId || '_';
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(t);
    }
    for (const arr of g.values()) {
      arr.sort((a, c) => (PRANK[a.priority || ''] ?? 9) - (PRANK[c.priority || ''] ?? 9)
        || (a.wave ?? 99) - (c.wave ?? 99) || a.id.localeCompare(c.id));
    }
    return { count: tickets.length, entries: [...g.entries()] };
  }, [board, f]); // eslint-disable-line react-hooks/exhaustive-deps

  // Same filtered ticket set as the list view's `groups`, grouped by status instead of
  // epic — the Kanban columns. Statuses outside BOARD_STATUSES (archived/duplicate/wont-do)
  // only show up here via the "all"/"archive" focus modes, so they're appended after the
  // canonical workflow columns rather than baked into BOARD_STATUSES itself.
  const statusGroups = useMemo(() => {
    const tickets = sourceFor().filter(matches);
    const g = new Map<string, BoardTicket[]>();
    for (const t of tickets) {
      const k = t.status || '_';
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(t);
    }
    // Every canonical status gets a column even with zero tickets — an empty column is still a
    // valid drop target (e.g. dragging the board's only "blocked" ticket back to "todo" must
    // not make "blocked" disappear from under the cursor). Non-canonical statuses (archived/
    // duplicate/wont-do) only show up via "all"/"archive" focus and only when actually present.
    const extras = [...g.keys()].filter((s) => !BOARD_STATUSES.includes(s));
    const order = f.focus === 'archive' ? [...g.keys()] : [...BOARD_STATUSES, ...extras];
    for (const arr of g.values()) {
      arr.sort((a, c) => (PRANK[a.priority || ''] ?? 9) - (PRANK[c.priority || ''] ?? 9) || a.id.localeCompare(c.id));
    }
    return order.map((s) => [s, g.get(s) ?? []] as const);
  }, [board, f]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusTickets = useMemo(() => sourceFor(), [board, f.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const visibleEpics = useMemo(() => {
    const candidates = f.focus === 'archive' ? board.archivedEpics
      : f.focus === 'all' ? [...board.epics, ...board.archivedEpics] : board.epics;
    const populated = new Set(focusTickets.map((t) => t.epicId).filter(Boolean));
    return candidates.filter((e, i) => populated.has(e.id) && candidates.findIndex((c) => c.id === e.id) === i);
  }, [board, f.focus, focusTickets]);
  const epicCountMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of focusTickets) if (t.epicId) m.set(t.epicId, (m.get(t.epicId) || 0) + 1);
    return m;
  }, [focusTickets]);

  const clear = () => setF({ status: '', priority: '', area: '', q: '', focus: 'active', epic: '', initiative: '' });

  const patchTicket = (id: string, patch: Partial<BoardTicket>) =>
    update((b) => { const t = b.tickets.find((x) => x.id === id); if (t) Object.assign(t, patch); return b; });
  const deleteTicket = (id: string) => {
    update((b) => { b.tickets = b.tickets.filter((x) => x.id !== id); return b; });
    setSel(null);
  };
  const addTicket = () => {
    const id = nextTicketId(board);
    update((b) => {
      b.tickets.unshift({
        id, name: 'New ticket', desc: '', status: 'backlog', priority: 'P2',
        epicId: f.epic || board.epics[0]?.id || '', area: config?.areas?.[0] || '',
        depends_on: [], agent_plan: [], model: config?.models?.[1] || 'sonnet',
      });
      return b;
    });
    setSel(id);
  };

  const selTicket = sel ? board.tickets.find((t) => t.id === sel) : null;

  const StatCard = ({ label, value, color, focus }: { label: string; value: number; color?: string; focus?: string }) => (
    <Card onClick={focus ? () => setF({ ...f, focus, epic: '' }) : undefined}
      sx={{ p: 1.6, flex: 1, minWidth: 104, cursor: focus ? 'pointer' : 'default',
        outline: focus && f.focus === focus ? (th) => `2px solid ${th.palette.primary.main}` : 'none' }}>
      <Typography sx={{ fontSize: 25, fontWeight: 800, lineHeight: 1, color: color || 'text.primary' }}>{value}</Typography>
      <Typography sx={{ mt: 0.7, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em', color: 'text.secondary' }}>{label}</Typography>
    </Card>
  );

  const doneIds = new Set([...board.archived, ...board.tickets].filter((x) => x.status === 'done').map((x) => x.id));

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
        {/* The absolute board path is diagnostic, not decoration — it dominated the header and
            told you nothing the project name in the app bar doesn't. Kept as a tooltip. */}
        <Typography variant="h6" sx={{ fontWeight: 800 }} title={board.boardDir}>Board</Typography>
        <Box sx={{ flexGrow: 1 }} />
        {save !== 'idle' && <Badge label={SAVE_LABEL[save]} color={save === 'error' ? '#f43f5e' : save === 'saving' ? '#9aa0bd' : '#10b981'} />}
        <Button size="small" variant="outlined" onClick={reload} sx={{ ml: 1 }}>Refresh</Button>
      </Box>
      {save === 'error' && <Typography variant="body2" color="error" sx={{ mb: 1 }}>{error}</Typography>}

      <Box sx={{ display: 'flex', gap: 1.2, flexWrap: 'wrap', mb: 2 }}>
        <StatCard label="Active tickets" value={stats.active} focus="active" />
        <StatCard label="P0 critical" value={stats.p0} color="error.main" />
        <StatCard label="Ready now" value={stats.ready} color="success.main" focus="ready" />
        <StatCard label="Blocked" value={stats.blocked} color="error.main" focus="blocked" />
        <StatCard label="Human gates" value={stats.gated} color="warning.main" focus="gated" />
        <StatCard label="Completed" value={stats.done} focus="archive" />
      </Box>

      <Card sx={{ p: 1.2, mb: 2, position: 'sticky', top: 58, zIndex: 10, display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', backdropFilter: 'blur(10px)', bgcolor: (th) => alpha(th.palette.background.paper, 0.85) }}>
        <TextField placeholder="Search…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} sx={{ flexGrow: 1, minWidth: 200 }} />
        <TextField select label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} sx={{ minWidth: 120 }}>
          <MenuItem value="">All</MenuItem>
          {BOARD_STATUSES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
        </TextField>
        <TextField select label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} sx={{ minWidth: 95 }}>
          <MenuItem value="">All</MenuItem>
          {PRIORITIES.map((p) => <MenuItem key={p} value={p}>{p}</MenuItem>)}
        </TextField>
        <TextField select label="Area" value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} sx={{ minWidth: 110 }}>
          <MenuItem value="">All</MenuItem>
          {areas.map((a) => <MenuItem key={a} value={a}>{a}</MenuItem>)}
        </TextField>
        {planScope.initiativeMode && (
          <TextField select label="Initiative" value={f.initiative} onChange={(e) => setF({ ...f, initiative: e.target.value, epic: '' })} sx={{ minWidth: 150 }}>
            <MenuItem value="">All</MenuItem>
            {planScope.initiatives.map((i) => <MenuItem key={i.id} value={i.id}>{i.id} — {i.name}</MenuItem>)}
          </TextField>
        )}
        <Button size="small" onClick={clear}>Clear</Button>
      </Card>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '236px minmax(0, 1fr)' }, gap: 2, alignItems: 'start' }}>
        <Card sx={{ p: 0, overflow: 'hidden', position: { md: 'sticky' }, top: 120 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', px: 1.6, pt: 1.4, pb: 0.8 }}>
            <Typography sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'text.secondary' }}>Epics</Typography>
            <Box sx={{ flexGrow: 1 }} />
            <Button size="small" onClick={() => setEpicsOpen(true)} sx={{ minWidth: 0, fontSize: 11 }}>Manage</Button>
          </Box>
          <EpicItem active={!f.epic} onClick={() => setF({ ...f, epic: '' })} name={f.epic ? 'Show all epics' : 'All epics'} count={focusTickets.length} />
          {!planScope.initiativeMode
            ? visibleEpics.map((e, i) => (
              <EpicItem key={e.id} active={f.epic === e.id} onClick={() => setF({ ...f, epic: e.id })} no={i + 1} name={e.name} count={epicCountMap.get(e.id) || 0} />
            ))
            : groupEpicsByInitiative(visibleEpics, planScope.initiatives).map((g) => (
              <Box key={g.id ?? '_none'}>
                <Typography sx={{ px: 1.6, pt: 1.2, pb: 0.4, fontSize: 10, fontWeight: 800, letterSpacing: '.1em',
                  textTransform: 'uppercase', color: g.id ? 'primary.main' : 'warning.main' }}>
                  {g.id ? `${g.id} · ${g.name}` : 'No initiative'}
                </Typography>
                {g.epics.map((e, i) => (
                  <EpicItem key={e.id} active={f.epic === e.id} onClick={() => setF({ ...f, epic: e.id })}
                    no={i + 1} name={e.name} count={epicCountMap.get(e.id) || 0} />
                ))}
              </Box>
            ))}
        </Card>

        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mb: 1 }}>
            <Box sx={{ display: 'flex', border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
              <Button size="small" onClick={() => setView('list')}
                variant={view === 'list' ? 'contained' : 'text'} sx={{ minWidth: 0, borderRadius: 0 }}>List</Button>
              <Button size="small" onClick={() => setView('kanban')}
                variant={view === 'kanban' ? 'contained' : 'text'} sx={{ minWidth: 0, borderRadius: 0 }}>Board</Button>
            </Box>
            <Button size="small" variant="outlined" onClick={addTicket} sx={{ minWidth: 0 }}>+ ticket</Button>
          </Box>
          {view === 'kanban' ? (
            <KanbanBoard statusGroups={statusGroups} board={board} statusColor={statusColor}
              priorityColor={priorityColor} onOpen={(id) => setSel(id)}
              onMove={(id, status) => patchTicket(id, { status })} />
          ) : groups.count === 0 ? (
            <Box sx={{ p: 5, textAlign: 'center', border: '1px dashed', borderColor: 'divider', borderRadius: 2, color: 'text.secondary' }}>No tickets match these filters.</Box>
          ) : groups.entries.map(([epicId, tickets]) => (
            <Box key={epicId} sx={{ mb: 2.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1, px: 0.3 }}>
                <Typography sx={{ fontWeight: 700, fontSize: 15 }}>{epicId === '_' ? 'Unassigned' : epicName(board, epicId)}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {tickets.length} · {tickets.filter((t) => isReady(t, board)).length} ready · {tickets.filter((t) => t.status === 'blocked').length} blocked
                </Typography>
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }, gap: 1.2 }}>
                {tickets.map((t) => {
                  const deps = t.depends_on || [];
                  const ready = isReady(t, board);
                  const isArchived = t.status === 'done';
                  const live = Boolean(board.tickets.find((x) => x.id === t.id));
                  return (
                    <Card key={t.id} onClick={() => live && setSel(t.id)}
                      sx={{ p: 1.8, cursor: live ? 'pointer' : 'default', opacity: isArchived ? 0.72 : 1,
                        transition: '.15s', '&:hover': { borderColor: 'primary.main', transform: live ? 'translateY(-1px)' : 'none' } }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                        <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 11.5, color: 'primary.main' }}>{t.id}</Typography>
                        <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap' }}>
                          {t.priority && <Badge label={t.priority} color={priorityColor(t.priority)} />}
                          <Badge label={t.status} color={statusColor(t.status)} />
                          {ready && <Badge label="ready" color="#1f9e5b" strong />}
                          {isGated(t) && <Badge label="gate" color={priorityColor('P1')} strong />}
                          {/* Placeholder content from a starter, so it reads as "replace me" rather
                              than as real work. `maestro ticket import --replace-sample` clears it. */}
                          {t.sample === true && <Badge label="sample" color="#8b8f9a" />}
                        </Box>
                      </Box>
                      <Typography sx={{ mt: 1.2, mb: 0.8, fontSize: 14.5, fontWeight: 600, lineHeight: 1.3 }}>{t.name}</Typography>
                      {t.desc && (
                        <Typography sx={{ color: 'text.secondary', fontSize: 12.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{stripMd(String(t.desc))}</Typography>
                      )}
                      {deps.length > 0 && (
                        <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap', mt: 1.2 }}>
                          {deps.map((d) => (
                            <Box key={d} component="span" sx={{ fontSize: 10.5, fontFamily: 'monospace', px: 0.7, py: 0.2, borderRadius: 1,
                              border: '1px solid', borderColor: doneIds.has(d) ? alpha('#1f9e5b', 0.4) : alpha('#d8504f', 0.4),
                              color: doneIds.has(d) ? 'success.main' : 'error.main' }}>{d}</Box>
                          ))}
                        </Box>
                      )}
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 1.4, pt: 1.2, borderTop: '1px solid', borderColor: 'divider', fontSize: 11, color: 'text.secondary', gap: 1 }}>
                        <Box sx={{ display: 'flex', gap: 0.6, alignItems: 'center', minWidth: 0 }}>
                          <span>{t.area || 'unassigned'}</span>
                          {t.model && <Badge label={t.model} color={modelColor(t.model)} />}
                        </Box>
                        <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{planLabel(t)}</span>
                      </Box>
                      {(t.dev_runtime || t.reviewer_runtime) && (
                        <Box sx={{ mt: 0.6, fontSize: 10.5, fontFamily: 'monospace', color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          dev:{t.dev_runtime || '—'}/{t.dev_model || '—'} → reviewer:{t.reviewer_runtime || '—'}/{t.reviewer_model || '—'}
                        </Box>
                      )}
                    </Card>
                  );
                })}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>

      <TicketDrawer board={board} config={config} ticket={selTicket || null} onClose={() => setSel(null)}
        onPatch={(patch) => sel && patchTicket(sel, patch)} onDelete={() => sel && deleteTicket(sel)} />
      <EpicsDialog board={board} open={epicsOpen} onClose={() => setEpicsOpen(false)} update={update} />
    </Container>
  );
}

// Kanban view: the same filtered tickets as the list view, grouped by status into columns.
// Moving a ticket is native HTML5 drag-and-drop between columns — no drag library needed —
// which calls the same patchTicket/update path the list view's drawer already uses, so it
// gets the existing optimistic-concurrency + validateBoard + backup behavior for free.
function KanbanBoard({ statusGroups, board, statusColor, priorityColor, onOpen, onMove }: {
  statusGroups: readonly (readonly [string, BoardTicket[]])[];
  board: Board; statusColor: (s: string) => string; priorityColor: (p?: string) => string;
  onOpen: (id: string) => void; onMove: (id: string, status: string) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<string | null>(null);
  const statusOf = new Map<string, string>();
  for (const [status, tickets] of statusGroups) for (const t of tickets) statusOf.set(t.id, status);

  const drop = (status: string) => (e: React.DragEvent) => {
    e.preventDefault();
    setOverStatus(null);
    const id = e.dataTransfer.getData('text/plain');
    setDragId(null);
    if (!id || statusOf.get(id) === status) return;
    // Completion is not a board edit: it is the merge + evidence + archive operation owned
    // by `maestro run` / land-and-archive. A drag must never unblock dependants by itself.
    if (status === 'done') return;
    onMove(id, status);
  };

  return (
    <Box sx={{ display: 'flex', gap: 1.4, overflowX: 'auto', pb: 1, alignItems: 'flex-start' }}>
      {statusGroups.map(([status, tickets]) => (
        <Box key={status}
          onDragOver={(e) => { if (status !== 'done') { e.preventDefault(); setOverStatus(status); } }}
          onDragLeave={() => setOverStatus((s) => (s === status ? null : s))}
          onDrop={drop(status)}
          sx={{
            flex: '0 0 260px', minWidth: 260, borderRadius: 2, p: 0.6,
            bgcolor: overStatus === status ? 'action.hover' : 'transparent',
            outline: overStatus === status ? (th) => `2px dashed ${th.palette.primary.main}` : 'none',
            transition: 'background-color .1s', opacity: status === 'done' ? 0.72 : 1,
          }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8, mb: 1, px: 0.3 }}>
            <Badge label={status} color={statusColor(status)} strong />
            <Typography variant="caption" color="text.secondary">{tickets.length}</Typography>
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minHeight: 40 }}>
            {tickets.map((t) => {
              const live = Boolean(board.tickets.find((x) => x.id === t.id));
              return (
                <Card key={t.id} draggable={live}
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; setDragId(t.id); }}
                  onDragEnd={() => { setDragId(null); setOverStatus(null); }}
                  onClick={() => live && onOpen(t.id)}
                  sx={{ p: 1.4, cursor: live ? 'grab' : 'default', opacity: dragId === t.id ? 0.4 : 1,
                    '&:active': { cursor: live ? 'grabbing' : 'default' } }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                    <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 11, color: 'primary.main' }}>{t.id}</Typography>
                    {t.priority && <Badge label={t.priority} color={priorityColor(t.priority)} />}
                  </Box>
                  <Typography sx={{ mt: 0.8, fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{t.name}</Typography>
                </Card>
              );
            })}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

// Plain-text reduction of markdown for tight card previews.
function stripMd(text: string): string {
  return (text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  if (children == null || children === '') return null;
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography variant="overline" color="text.secondary">{label}</Typography>
      <Box sx={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{children}</Box>
    </Box>
  );
}

// Toggle-chip editor for a ticket's agent_plan, in canonical pipeline order.
function PlanEditor({ value, options, onChange }: { value: string[]; options: string[]; onChange: (v: string[]) => void }) {
  const set = new Set(value);
  const toggle = (code: string) => {
    const next = new Set(set);
    if (next.has(code)) next.delete(code); else next.add(code);
    onChange(options.filter((o) => next.has(o))); // keep canonical order
  };
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">Agent plan (the pipeline this ticket runs through)</Typography>
      <Box sx={{ display: 'flex', gap: 0.7, flexWrap: 'wrap', mt: 0.6 }}>
        {options.map((code) => (
          <Chip key={code} label={code} size="small" onClick={() => toggle(code)}
            color={set.has(code) ? 'primary' : 'default'} variant={set.has(code) ? 'filled' : 'outlined'} />
        ))}
      </Box>
      {value.length > 0 && (
        <Typography variant="caption" sx={{ mt: 0.8, display: 'block', fontFamily: 'monospace', color: 'text.secondary' }}>
          {value.join(' › ')}
        </Typography>
      )}
    </Box>
  );
}

// Cross-review pickers: independent runtime adapter + model selection for the dev and reviewer
// roles. Blank ticket fields inherit config.crossReview when present; with no project default,
// a blank pair keeps the classic single-pipeline agent_plan. Runtime options reflect installed
// adapters surfaced by the server.
function RolePicker({ label, runtime, model, runtimeOptions, onChange }: {
  label: string; runtime?: string; model?: string; runtimeOptions: string[];
  onChange: (patch: { runtime?: string; model?: string }) => void;
}) {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
      <Typography variant="caption" color="text.secondary" sx={{ width: 62, flex: '0 0 auto' }}>{label}</Typography>
      <TextField select size="small" label="Runtime" value={runtime || ''} sx={{ flex: 1 }}
        onChange={(e) => onChange({ runtime: e.target.value || undefined })}>
        <MenuItem value="">—</MenuItem>
        {runtimeOptions.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
      </TextField>
      <TextField size="small" label="Model / tier" value={model || ''} sx={{ flex: 1 }}
        placeholder="sonnet or model id"
        onChange={(e) => onChange({ model: e.target.value || undefined })} />
    </Box>
  );
}

type DrawerProps = {
  board: Board; config: ProjectConfig | null; ticket: BoardTicket | null;
  onClose: () => void; onPatch: (patch: Partial<BoardTicket>) => void; onDelete: () => void;
};

function TicketDrawer({ board, config, ticket: t, onClose, onPatch, onDelete }: DrawerProps) {
  const { statusColor, priorityColor } = useAccents();
  const [edit, setEdit] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [spec, setSpec] = useState('');
  const [specSaved, setSpecSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const statusOptions = t
    ? [...new Set([...BOARD_STATUSES.filter((s) => s !== 'done'), t.status])]
    : BOARD_STATUSES.filter((s) => s !== 'done');
  const planSteps = planStepsFor(config);
  const depOptions = t ? allTicketRefs(board).filter((r) => r.id !== t.id) : [];
  const useAreaSelect = (config?.areas?.length ?? 0) > 0;
  // A config.json that explicitly disables every runtime (targets: {claude:false, codex:false})
  // must not be silently widened back to both — that defeats the point of the check in
  // board-core.mjs's validateBoard. Only fall back when there's no config.json at all to ask.
  const runtimeOptions = config ? config.targets : ['claude', 'codex'];

  // The project plan, for the scope controls below. The verdict shown here is a preview: the
  // validator warns and the orchestrator blocks on the server's own reading of the same rules.
  const scope = usePlanScope();
  // The epic is passed in so the verdict can derive the ticket's initiative the way the server
  // does. A ticket has no initiative field of its own, and adding one would be a second source
  // of truth that drifts the first time an epic moves.
  const ticketEpic = t?.epicId ? [...board.epics, ...board.archivedEpics].find((e) => e.id === t.epicId) : null;
  const verdict = t ? scope.verdict(t, ticketEpic ?? null) : null;
  const foreign = scope.foreignFor(ticketEpic?.initiativeId ?? null);

  // Load the ticket's spec whenever the open ticket changes.
  useEffect(() => {
    setConfirmDel(false); setSpecSaved('idle');
    if (t) getSpec(t.id).then(setSpec).catch(() => setSpec('')); else setSpec('');
  }, [t?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSpec = () => {
    if (!t) return;
    setSpecSaved('saving');
    putSpec(t.id, spec).then(() => setSpecSaved('saved')).catch(() => setSpecSaved('idle'));
  };

  return (
    <Drawer anchor="right" open={!!t} onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: '100vw', sm: 560 }, p: 3 } } }}>
      {t && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{t.id}</Typography>
            <Badge label={t.status} color={statusColor(t.status)} />
            {t.priority && <Badge label={t.priority} color={priorityColor(t.priority)} />}
            <Box sx={{ flexGrow: 1 }} />
            <Button size="small" variant={edit ? 'contained' : 'outlined'} onClick={() => setEdit(!edit)}>{edit ? 'Done' : 'Edit'}</Button>
            <IconButton size="small" onClick={onClose}>✕</IconButton>
          </Box>

          <Box sx={{ display: 'flex', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
            <TextField select label="Status" value={t.status} onChange={(e) => onPatch({ status: e.target.value })} sx={{ minWidth: 150 }}>
              {statusOptions.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
            <TextField select label="Priority" value={t.priority || ''} onChange={(e) => onPatch({ priority: e.target.value })} sx={{ minWidth: 110 }}>
              <MenuItem value="">—</MenuItem>
              {PRIORITIES.map((p) => <MenuItem key={p} value={p}>{p}</MenuItem>)}
            </TextField>
            <TextField select label="Model" value={t.model || ''} onChange={(e) => onPatch({ model: e.target.value })} sx={{ minWidth: 110 }}>
              <MenuItem value="">—</MenuItem>
              {MODELS.map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
            </TextField>
          </Box>
          <Divider sx={{ mb: 2 }} />

          {edit ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              <TextField label="Name" value={t.name} onChange={(e) => onPatch({ name: e.target.value })} fullWidth />
              <TextField label="Description" value={t.desc || ''} onChange={(e) => onPatch({ desc: e.target.value })} fullWidth multiline minRows={3} />
              <Box sx={{ display: 'flex', gap: 1.5 }}>
                {useAreaSelect ? (
                  <TextField select label="Area" value={t.area || ''} onChange={(e) => onPatch({ area: e.target.value })} sx={{ flex: 1 }}>
                    <MenuItem value="">—</MenuItem>
                    {[...new Set([...(config?.areas || []), ...(t.area ? [t.area] : [])])].map((a) => <MenuItem key={a} value={a}>{a}</MenuItem>)}
                  </TextField>
                ) : (
                  <TextField label="Area" value={t.area || ''} onChange={(e) => onPatch({ area: e.target.value })} sx={{ flex: 1 }} />
                )}
                <TextField label="Swag" value={t.swag || ''} onChange={(e) => onPatch({ swag: e.target.value })} sx={{ width: 90 }} />
                <TextField label="Wave" type="number" value={t.wave ?? ''} onChange={(e) => onPatch({ wave: e.target.value === '' ? undefined : Number(e.target.value) })} sx={{ width: 90 }} />
              </Box>
              <TextField select label="Epic" value={board.epics.find((e) => e.id === t.epicId) ? t.epicId : ''} onChange={(e) => onPatch({ epicId: e.target.value })} fullWidth
                helperText={board.epics.length ? undefined : 'no epics yet — add one from the board’s Epics ▸ Manage'}>
                <MenuItem value="">— none —</MenuItem>
                {board.epics.map((ep) => (
                  <MenuItem key={ep.id} value={ep.id}>
                    {ep.name} ({ep.id}){scope.initiativeMode && ep.initiativeId ? ` · ${scope.initiativeName(ep.initiativeId)}` : ''}
                  </MenuItem>
                ))}
              </TextField>

              {scope.initiativeMode && (
                // READ-ONLY on purpose. A ticket's initiative is derived through its epic; an
                // editable field here would be a second source of truth that disagrees with the
                // epic the moment either one moves.
                <Typography sx={{ fontSize: 12.5, mt: -0.6, color: ticketEpic?.initiativeId ? 'text.secondary' : 'warning.main' }}>
                  {ticketEpic?.initiativeId
                    ? `Initiative: ${ticketEpic.initiativeId} — ${scope.initiativeName(ticketEpic.initiativeId)} (from its epic; not set here)`
                    : ticketEpic
                      ? `Initiative: none — epic ${ticketEpic.id} is unassigned, so this ticket will not be picked. Assign it in Epics ▸ Manage.`
                      : 'Initiative: none — with no epic this ticket may trace only to project-wide items.'}
                </Typography>
              )}

              <PlanEditor value={t.agent_plan || []} options={planSteps} onChange={(v) => onPatch({ agent_plan: v })} />

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  Cross-review (optional; blank values {config?.crossReview ? 'inherit the project defaults' : 'use the classic agent_plan above'})
                </Typography>
                <RolePicker label="Dev" runtime={t.dev_runtime} model={t.dev_model} runtimeOptions={runtimeOptions}
                  onChange={(patch) => onPatch({
                    dev_runtime: 'runtime' in patch ? patch.runtime : t.dev_runtime,
                    dev_model: 'model' in patch ? patch.model : t.dev_model,
                  })} />
                <RolePicker label="Reviewer" runtime={t.reviewer_runtime} model={t.reviewer_model} runtimeOptions={runtimeOptions}
                  onChange={(patch) => onPatch({
                    reviewer_runtime: 'runtime' in patch ? patch.runtime : t.reviewer_runtime,
                    reviewer_model: 'model' in patch ? patch.model : t.reviewer_model,
                  })} />
              </Box>

              <TextField label="Test command" value={t.testCmd || ''} onChange={(e) => onPatch({ testCmd: e.target.value || undefined })} fullWidth
                helperText="Overrides the area default in the release gate — required before maestro run will create or merge a cross-review PR." />

              <Box>
                <Typography variant="caption" color="text.secondary">Depends on (blocks this ticket until they’re done)</Typography>
                <Select multiple fullWidth size="small" value={t.depends_on || []}
                  onChange={(e) => onPatch({ depends_on: typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value })}
                  input={<OutlinedInput />} sx={{ mt: 0.6 }}
                  renderValue={(vals) => (
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      {(vals as string[]).map((v) => <Chip key={v} label={v} size="small" />)}
                    </Box>
                  )}>
                  {depOptions.map((r) => (
                    <MenuItem key={r.id} value={r.id}>
                      <Checkbox checked={(t.depends_on || []).includes(r.id)} size="small" />
                      <ListItemText primary={r.id} secondary={r.name} />
                    </MenuItem>
                  ))}
                </Select>
              </Box>

              <Box>
                <Select multiple size="small" fullWidth displayEmpty
                  value={t.traces_to || []}
                  onChange={(e) => onPatch({ traces_to: (typeof e.target.value === 'string' ? [e.target.value] : e.target.value) as string[] })}
                  input={<OutlinedInput />}
                  renderValue={(sel) => (
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      {(sel as string[]).length === 0
                        ? <Typography sx={{ color: 'text.disabled', fontSize: 13 }}>Traces to — nothing (out of scope)</Typography>
                        : (sel as string[]).map((id) => (
                          <Chip key={id} label={id} size="small"
                            color={scope.byId.get(id)?.out ? 'error' : scope.byId.has(id) ? 'default' : 'warning'}
                            sx={{ fontFamily: 'monospace', height: 20, fontSize: 11 }} />
                        ))}
                    </Box>
                  )}>
                  {scope.options.length === 0 && <MenuItem disabled value="">No plan items yet — write the plan first</MenuItem>}
                  {scope.options.map((o) => {
                    // Another initiative's item is offered but disabled, exactly as an OUT- id
                    // is shown rather than hidden: the reader has to be able to see that the
                    // requirement exists and why it is unavailable, or they will assume the
                    // plan is missing it and file a duplicate.
                    const isForeign = foreign.has(o.id) && !(t.traces_to || []).includes(o.id);
                    return (
                      <MenuItem key={o.id} value={o.id} disabled={isForeign}>
                        <Checkbox checked={(t.traces_to || []).includes(o.id)} size="small" disabled={isForeign} />
                        <ListItemText primary={`${o.id}${o.out ? '  (out of scope)' : ''}`}
                          secondary={isForeign
                            ? `owned by ${scope.initiativeName(o.initiativeId)} — this ticket is in another initiative`
                            : `${scope.label(o.section)} — ${o.text}`} />
                      </MenuItem>
                    );
                  })}
                </Select>
                {verdict && (
                  <Typography sx={{ fontSize: 12, mt: 0.6, color: verdict.blocks ? 'warning.main' : 'text.secondary' }}>
                    {verdict.blocks ? '⚠ ' : ''}{verdict.reason}
                  </Typography>
                )}
              </Box>

              <TextField label="Scope exception" value={String(t.scope_exception || '')}
                onChange={(e) => onPatch({ scope_exception: e.target.value || undefined })} fullWidth
                helperText="A written reason for running this ticket even though the plan doesn't cover it. Clears the gate — and stays visible in every report, so it can't quietly become the norm." />

              <TextField select label="Human gate" value={t.human_gate || ''} onChange={(e) => onPatch({ human_gate: e.target.value || undefined })} fullWidth
                helperText="requires a person to clear it before the orchestrator auto-picks it">
                <MenuItem value="">— none —</MenuItem>
                {[...new Set([...(config?.humanGates || []), ...(t.human_gate ? [t.human_gate] : [])])].map((g) => <MenuItem key={g} value={g}>{g}</MenuItem>)}
              </TextField>

              <SpecEditor spec={spec} setSpec={setSpec} onSave={saveSpec} state={specSaved} setState={setSpecSaved} />
              <TextField label="Evidence" value={String(t.evidence || '')} onChange={(e) => onPatch({ evidence: e.target.value })} fullWidth multiline minRows={2} />

              <Box>
                {confirmDel ? (
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <Typography variant="body2">Delete {t.id}? This rewrites data.json.</Typography>
                    <Button color="error" size="small" variant="contained" onClick={onDelete}>Confirm</Button>
                    <Button size="small" onClick={() => setConfirmDel(false)}>Cancel</Button>
                  </Box>
                ) : (
                  <Button color="error" size="small" onClick={() => setConfirmDel(true)}>Delete ticket</Button>
                )}
              </Box>
            </Box>
          ) : (
            <>
              <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>{t.name}</Typography>
              <Field label="Epic">{epicName(board, t.epicId)}</Field>
              <Field label="Description">{t.desc}</Field>
              <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                <Field label="Area">{t.area}</Field>
                <Field label="Swag">{t.swag}</Field>
                <Field label="Wave">{t.wave}</Field>
                <Field label="Model">{t.model}</Field>
              </Box>
              <Field label="Agent plan">{planLabel(t) || '—'}</Field>
              {(t.dev_runtime || t.reviewer_runtime) && (
                <Field label="Cross-review">
                  {`dev: ${t.dev_runtime || '—'}/${t.dev_model || '—'}  →  reviewer: ${t.reviewer_runtime || '—'}/${t.reviewer_model || '—'}`}
                </Field>
              )}
              <Field label="Test command">{t.testCmd}</Field>
              <Field label="Depends on">{(t.depends_on || []).join(', ') || '—'}</Field>
              <Field label="Traces to">{(t.traces_to || []).join(', ') || '—'}</Field>
              {verdict && verdict.state !== 'no-plan' && (
                <Typography sx={{ fontSize: 12, mb: 1.5, color: verdict.blocks ? 'warning.main' : 'text.secondary' }}>
                  {verdict.blocks ? '⚠ ' : ''}{verdict.reason}
                </Typography>
              )}
              {t.scope_exception && <Field label="Scope exception">{String(t.scope_exception)}</Field>}
              <Field label="Human gate">{t.human_gate}</Field>
              {spec.trim() && <Field label="Spec"><Box component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', m: 0 }}>{spec}</Box></Field>}
              <Field label="Evidence">{String(t.evidence || '')}</Field>
            </>
          )}
        </>
      )}
    </Drawer>
  );
}

function SpecEditor({ spec, setSpec, onSave, state, setState }: {
  spec: string; setSpec: (s: string) => void; onSave: () => void;
  state: 'idle' | 'saving' | 'saved'; setState: (s: 'idle' | 'saving' | 'saved') => void;
}) {
  return (
    <Box>
      <TextField label="Spec (long-form detail — saved to board/specs/&lt;id&gt;.md)" value={spec}
        onChange={(e) => { setSpec(e.target.value); setState('idle'); }} fullWidth multiline minRows={4}
        helperText="Optional. Use for acceptance criteria, design notes, anything longer than the description." />
      <Box sx={{ mt: 0.6 }}>
        <Button size="small" variant="outlined" onClick={onSave} disabled={state === 'saving'}>
          {state === 'saving' ? 'saving…' : state === 'saved' ? 'spec saved ✓' : 'Save spec'}
        </Button>
      </Box>
    </Box>
  );
}

/**
 * Epics under their initiative, in plan order, with the unassigned ones last.
 *
 * "No initiative" is a real group, not a hidden one: in initiative mode an unassigned epic's
 * tickets are refused at pick time, so burying it is the opposite of useful — it is the group
 * someone needs to see.
 */
function groupEpicsByInitiative(epics: BoardEpic[], initiatives: { id: string; name: string }[]) {
  const groups = initiatives.map((i) => ({ id: i.id as string | null, name: i.name, epics: epics.filter((e) => e.initiativeId === i.id) }));
  const known = new Set(initiatives.map((i) => i.id));
  const orphans = epics.filter((e) => !e.initiativeId || !known.has(e.initiativeId));
  if (orphans.length) groups.push({ id: null, name: 'No initiative', epics: orphans });
  return groups.filter((g) => g.epics.length);
}

function EpicsDialog({ board, open, onClose, update }: {
  board: Board; open: boolean; onClose: () => void; update: (fn: (b: Board) => Board) => void;
}) {
  const [newName, setNewName] = useState('');
  const scope = usePlanScope();
  const rename = (id: string, name: string) =>
    update((b) => { const e = b.epics.find((x) => x.id === id); if (e) e.name = name; return b; });
  const remove = (id: string) =>
    update((b) => {
      b.epics = b.epics.filter((x) => x.id !== id);
      for (const t of b.tickets) if (t.epicId === id) t.epicId = ''; // orphaned tickets, not deleted
      return b;
    });
  const setInitiative = (id: string, initiativeId: string) =>
    update((b) => {
      const e = b.epics.find((x) => x.id === id);
      if (e) { if (initiativeId) e.initiativeId = initiativeId; else delete e.initiativeId; }
      return b;
    });
  const add = () => {
    const name = newName.trim();
    if (!name) return;
    const id = nextEpicId(board);
    // A new epic inherits the initiative currently filtered to, when there is exactly one
    // sensible answer; otherwise it starts unassigned and the validator says so.
    update((b) => { b.epics.push({ id, name }); return b; });
    setNewName('');
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Epics</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.2, mt: 0.5 }}>
          {board.epics.length === 0 && <Typography color="text.secondary" variant="body2">No epics yet. Add one below to group your tickets.</Typography>}
          {board.epics.map((e) => (
            <Box key={e.id} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Typography sx={{ fontFamily: 'monospace', fontSize: 12, color: 'primary.main', width: 34 }}>{e.id}</Typography>
              <TextField value={e.name} onChange={(ev) => rename(e.id, ev.target.value)} size="small" sx={{ flex: 1 }} />
              {scope.initiativeMode && (
                <TextField select size="small" value={e.initiativeId ?? ''} sx={{ minWidth: 165 }}
                  onChange={(ev) => setInitiative(e.id, ev.target.value)}
                  error={!e.initiativeId}
                  helperText={e.initiativeId ? undefined : 'tickets will not be picked'}>
                  <MenuItem value="">— no initiative —</MenuItem>
                  {scope.initiatives.map((i) => <MenuItem key={i.id} value={i.id}>{i.id} — {i.name}</MenuItem>)}
                </TextField>
              )}
              <Button color="error" size="small" onClick={() => remove(e.id)}>Delete</Button>
            </Box>
          ))}
          <Divider sx={{ my: 1 }} />
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField placeholder="New epic name…" value={newName} onChange={(e) => setNewName(e.target.value)}
              size="small" sx={{ flex: 1 }} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
            <Button variant="contained" size="small" onClick={add} disabled={!newName.trim()}>Add epic</Button>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}
