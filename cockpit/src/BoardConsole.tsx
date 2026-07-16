import { useMemo, useState } from 'react';
import {
  Box, Button, Card, Container, Divider, Drawer, IconButton, MenuItem, TextField, Typography, useTheme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { Board, BoardTicket } from './types';
import { useBoard } from './useBoard';
import { BOARD_STATUSES, PRIORITIES, MODELS, epicName, isReady, isGated, planLabel } from './boardLib';

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
  return <SingleBoard board={board} save={save} error={error} reload={reload} update={update} />;
}

type Props = {
  board: Board; save: string; error: string | null;
  reload: () => void; update: (fn: (b: Board) => Board) => void;
};

function SingleBoard({ board, save, error, reload, update }: Props) {
  const { statusColor, priorityColor, modelColor } = useAccents();
  const [f, setF] = useState({ status: '', priority: '', area: '', q: '', focus: 'active', epic: '' });
  const [sel, setSel] = useState<string | null>(null);

  const areas = useMemo(() => [...new Set(
    [...board.tickets, ...board.archived].map((t) => t.area).filter(Boolean),
  )].sort() as string[], [board]);

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
  const matches = (t: BoardTicket) =>
    (!f.status || t.status === f.status) &&
    (!f.priority || t.priority === f.priority) &&
    (!f.area || t.area === f.area) &&
    (!f.epic || t.epicId === f.epic) &&
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

  const clear = () => setF({ status: '', priority: '', area: '', q: '', focus: 'active', epic: '' });

  const patchTicket = (id: string, patch: Partial<BoardTicket>) =>
    update((b) => { const t = b.tickets.find((x) => x.id === id); if (t) Object.assign(t, patch); return b; });
  const deleteTicket = (id: string) => {
    update((b) => { b.tickets = b.tickets.filter((x) => x.id !== id); return b; });
    setSel(null);
  };
  const addTicket = () => {
    const id = (window.prompt('New ticket id:', 'T-') || '').trim();
    if (!id) return;
    if (board.tickets.find((t) => t.id === id)) { window.alert(`Ticket ${id} already exists.`); return; }
    update((b) => { b.tickets.unshift({ id, name: 'New ticket', desc: '', status: 'backlog', priority: 'P2', depends_on: [], agent_plan: [], model: 'sonnet' }); return b; });
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
        <Typography variant="h6" sx={{ fontWeight: 800 }}>Board</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>{board.boardDir}</Typography>
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
        <Button size="small" onClick={clear}>Clear</Button>
      </Card>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '236px minmax(0, 1fr)' }, gap: 2, alignItems: 'start' }}>
        <Card sx={{ p: 0, overflow: 'hidden', position: { md: 'sticky' }, top: 120 }}>
          <Typography sx={{ px: 1.6, pt: 1.4, pb: 0.8, fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'text.secondary' }}>Epics</Typography>
          <EpicItem active={!f.epic} onClick={() => setF({ ...f, epic: '' })} name={f.epic ? 'Show all epics' : 'All epics'} count={focusTickets.length} />
          {visibleEpics.map((e, i) => (
            <EpicItem key={e.id} active={f.epic === e.id} onClick={() => setF({ ...f, epic: e.id })} no={i + 1} name={e.name} count={epicCountMap.get(e.id) || 0} />
          ))}
        </Card>

        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
            <Button size="small" onClick={addTicket} sx={{ minWidth: 0 }}>+ ticket</Button>
          </Box>
          {groups.count === 0 ? (
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
                    </Card>
                  );
                })}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>

      <TicketDrawer board={board} ticket={selTicket || null} onClose={() => setSel(null)}
        onPatch={(patch) => sel && patchTicket(sel, patch)} onDelete={() => sel && deleteTicket(sel)} />
    </Container>
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

type DrawerProps = {
  board: Board; ticket: BoardTicket | null;
  onClose: () => void; onPatch: (patch: Partial<BoardTicket>) => void; onDelete: () => void;
};

function TicketDrawer({ board, ticket: t, onClose, onPatch, onDelete }: DrawerProps) {
  const { statusColor, priorityColor } = useAccents();
  const [edit, setEdit] = useState(false);
  const statusOptions = t ? [...new Set([...BOARD_STATUSES, t.status])] : BOARD_STATUSES;

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
                <TextField label="Area" value={t.area || ''} onChange={(e) => onPatch({ area: e.target.value })} sx={{ flex: 1 }} />
                <TextField label="Swag" value={t.swag || ''} onChange={(e) => onPatch({ swag: e.target.value })} sx={{ width: 90 }} />
                <TextField label="Wave" type="number" value={t.wave ?? ''} onChange={(e) => onPatch({ wave: e.target.value === '' ? undefined : Number(e.target.value) })} sx={{ width: 90 }} />
              </Box>
              <TextField label="Epic id" value={t.epicId || ''} onChange={(e) => onPatch({ epicId: e.target.value })} fullWidth
                helperText={board.epics.map((ep) => ep.id).join(', ') || 'no epics on this board'} />
              <TextField label="Agent plan (comma-separated codes)" value={(t.agent_plan || []).join(', ')}
                onChange={(e) => onPatch({ agent_plan: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} fullWidth
                helperText="e.g. pe, backend, qa, merge" />
              <TextField label="Depends on (comma-separated ids)" value={(t.depends_on || []).join(', ')}
                onChange={(e) => onPatch({ depends_on: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} fullWidth />
              <TextField label="Human gate" value={t.human_gate || ''} onChange={(e) => onPatch({ human_gate: e.target.value || undefined })} fullWidth
                helperText="set to require a human before this ticket is auto-picked" />
              <TextField label="Evidence" value={String(t.evidence || '')} onChange={(e) => onPatch({ evidence: e.target.value })} fullWidth multiline minRows={2} />
              <Box><Button color="error" size="small" onClick={() => { if (window.confirm(`Delete ${t.id}? This rewrites data.json.`)) onDelete(); }}>Delete ticket</Button></Box>
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
              <Field label="Depends on">{(t.depends_on || []).join(', ') || '—'}</Field>
              <Field label="Human gate">{t.human_gate}</Field>
              <Field label="Evidence">{String(t.evidence || '')}</Field>
            </>
          )}
        </>
      )}
    </Drawer>
  );
}
