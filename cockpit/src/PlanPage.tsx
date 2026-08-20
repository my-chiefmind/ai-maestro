import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Card, Chip, Container, IconButton, LinearProgress, MenuItem,
  Select, TextField, Tooltip, Typography,
} from '@mui/material';
import type {
  Plan, PlanCoverageRow, PlanItem, PlanResponse, PlanSectionMeta, PlanSectionStatus,
} from './types';
import { getPlan, putPlanSection, putPlanGap, PlanConflict } from './api';

/**
 * The project plan — every section, editable in place.
 *
 * The section list, their labels, their per-item fields and the completeness maths all come
 * from the server (scripts/plan-core.mjs). Nothing about the plan's shape is duplicated here:
 * adding a section to the registry makes it appear in this tab with no change to this file.
 *
 * Saves are section-scoped and carry the version they were loaded at, so a tab left open while
 * an agent writes a different section is not a conflict — and one that writes the SAME section
 * gets a 409 rather than silently winning.
 */
export default function PlanPage() {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    getPlan().then(setData).catch((e) => setError(String(e.message || e)));
  }, []);
  useEffect(load, [load]);

  const save = useCallback(async (key: string, value: unknown) => {
    if (!data) return;
    setError(null);
    try {
      const next = await putPlanSection(key, value, data.version);
      setData((d) => (d ? { ...d, ...next } : d));
      setNote(`Saved — plan is ${next.completeness.percent}% complete.`);
    } catch (e) {
      if (e instanceof PlanConflict) {
        setData((d) => (d ? { ...d, plan: e.current.plan, version: e.current.version, completeness: e.current.completeness } : d));
        setError(e.message);
      } else {
        setError(String((e as Error).message || e));
      }
    }
  }, [data]);

  const triage = useCallback(async (id: string, patch: { status?: string; need?: string; resolvedAs?: string }) => {
    if (!data) return;
    setError(null);
    try {
      const r = await putPlanGap(id, patch, data.version);
      setData((d) => (d ? { ...d, plan: r.plan, version: r.version, completeness: r.completeness } : d));
      setNote(`${id} updated — plan is ${r.completeness.percent}% complete.`);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }, [data]);

  if (error && !data) return <Container sx={{ py: 8 }}><Typography color="error">{error}</Typography></Container>;
  if (!data) return <Container sx={{ py: 8 }}><Typography>Loading the plan…</Typography></Container>;

  const statusByKey = new Map(data.completeness.sections.map((s) => [s.key, s]));
  const coverageById = new Map(data.coverage.map((c) => [c.id, c]));

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <PlanHeader data={data} />

      {error && <Banner tone="error" onClose={() => setError(null)}>{error}</Banner>}
      {note && !error && <Banner tone="ok" onClose={() => setNote(null)}>{note}</Banner>}

      {!data.exists && (
        <Card sx={{ p: 2, mb: 2, borderLeft: '3px solid', borderColor: 'warning.main' }}>
          <Typography sx={{ fontWeight: 700, mb: 0.5 }}>No plan yet</Typography>
          <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
            Nothing has been written to <code>{data.planPath}</code>. The scope gate stays off until
            this plan names a deliverable, use case, or requirement — so every ticket runs
            unchecked. Fill a section below, or run <code>/plan-update</code> for a guided pass.
          </Typography>
        </Card>
      )}

      {data.sections.map((meta) => (
        <SectionCard
          key={meta.key}
          meta={meta}
          status={statusByKey.get(meta.key)}
          plan={data.plan}
          coverage={coverageById}
          onSave={(value) => save(meta.key, value)}
          onTriage={triage}
        />
      ))}
    </Container>
  );
}

// ── Header: the percentage, and what is holding it down ─────────────────────────

function PlanHeader({ data }: { data: PlanResponse }) {
  const c = data.completeness;
  const tone = c.percent >= 90 ? 'success' : c.percent >= 50 ? 'warning' : 'error';
  const uncovered = data.coverage.filter((r) => !r.tickets.length);

  return (
    <Card sx={{ p: 2.4, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 800, fontSize: 20, letterSpacing: '-0.02em' }}>Project plan</Typography>
        <Typography sx={{ fontWeight: 800, fontSize: 20, color: `${tone}.main` }}>{c.percent}%</Typography>
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
          {c.missing.length
            ? `still missing: ${c.missing.map((k) => c.sections.find((s) => s.key === k)?.label ?? k).join(', ')}`
            : 'every section filled'}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Run this in Claude Code for a guided, section-by-section pass">
          <Chip size="small" label="/plan-update" sx={{ fontFamily: 'monospace', fontWeight: 700 }} />
        </Tooltip>
      </Box>

      <LinearProgress variant="determinate" value={c.percent} color={tone}
        sx={{ mt: 1.4, height: 7, borderRadius: 4 }} />

      <Box sx={{ display: 'flex', gap: 2.5, mt: 1.6, flexWrap: 'wrap', fontSize: 12.5, color: 'text.secondary' }}>
        {c.requiredGaps.length > 0 && (
          <span>
            <b style={{ color: 'inherit' }}>{c.requiredGaps.length}</b> required gap
            {c.requiredGaps.length === 1 ? '' : 's'} open — these hold the percentage down until
            accepted or declined
          </span>
        )}
        {uncovered.length > 0 && (
          <span><b>{uncovered.length}</b> plan item{uncovered.length === 1 ? '' : 's'} with no ticket</span>
        )}
      </Box>

      {data.warnings.length > 0 && (
        <Box sx={{ mt: 1.4 }}>
          {data.warnings.map((w) => (
            <Typography key={w} sx={{ fontSize: 12, color: 'warning.main' }}>⚠ {w}</Typography>
          ))}
        </Box>
      )}
    </Card>
  );
}

function Banner({ tone, children, onClose }: { tone: 'error' | 'ok'; children: React.ReactNode; onClose: () => void }) {
  return (
    <Card sx={{ p: 1.4, mb: 2, display: 'flex', alignItems: 'center', gap: 1,
      borderLeft: '3px solid', borderColor: tone === 'error' ? 'error.main' : 'success.main' }}>
      <Typography sx={{ fontSize: 13, flexGrow: 1, color: tone === 'error' ? 'error.main' : 'text.secondary' }}>
        {children}
      </Typography>
      <IconButton size="small" onClick={onClose} aria-label="dismiss">✕</IconButton>
    </Card>
  );
}

// ── One section ─────────────────────────────────────────────────────────────────

function SectionCard({ meta, status, plan, coverage, onSave, onTriage }: {
  meta: PlanSectionMeta;
  status?: PlanSectionStatus;
  plan: Plan;
  coverage: Map<string, PlanCoverageRow>;
  onSave: (value: unknown) => void;
  onTriage: (id: string, patch: { status?: string; need?: string; resolvedAs?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const filled = status?.filled ?? false;
  const count = status?.count ?? 0;

  return (
    <Card sx={{ mb: 1.6, overflow: 'hidden' }}>
      <Box onClick={() => setOpen((o) => !o)}
        sx={{ display: 'flex', alignItems: 'center', gap: 1.2, px: 2, py: 1.4, cursor: 'pointer',
          '&:hover': { bgcolor: 'action.hover' } }}>
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          bgcolor: !status?.counts ? 'text.disabled' : filled ? 'success.main' : 'warning.main' }} />
        <Typography sx={{ fontWeight: 700 }}>{meta.heading}</Typography>
        {count > 0 && <Chip size="small" label={count} sx={{ height: 18, fontSize: 11 }} />}
        {status?.detail && (
          <Typography sx={{ fontSize: 12, color: 'warning.main' }}>{status.detail}</Typography>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>{open ? '▾' : '▸'}</Typography>
      </Box>

      {open && (
        <Box sx={{ px: 2, pb: 2, borderTop: '1px solid', borderColor: 'divider', pt: 1.6 }}>
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mb: 1.6 }}>{meta.blurb}</Typography>
          {meta.kind === 'prose' && <GoalEditor plan={plan} onSave={onSave} />}
          {meta.kind === 'scope' && <ScopeEditor plan={plan} onSave={onSave} />}
          {meta.kind === 'list' && (
            <ListEditor meta={meta} items={plan.sections[meta.key] as PlanItem[]} coverage={coverage} onSave={onSave} />
          )}
          {meta.kind === 'gaps' && (
            <GapEditor items={plan.sections.gaps} onTriage={onTriage} />
          )}
        </Box>
      )}
    </Card>
  );
}

// ── Goal ────────────────────────────────────────────────────────────────────────

function GoalEditor({ plan, onSave }: { plan: Plan; onSave: (v: unknown) => void }) {
  const goal = plan.sections.goal;
  const [text, setText] = useState(goal.text);
  const [metrics, setMetrics] = useState<string[]>(goal.metrics.length ? goal.metrics : ['']);
  useEffect(() => { setText(goal.text); setMetrics(goal.metrics.length ? goal.metrics : ['']); }, [goal]);

  const dirty = text !== goal.text || metrics.filter(Boolean).join(' ') !== goal.metrics.join(' ');

  return (
    <Box>
      <TextField label="The outcome this project exists to produce" value={text}
        onChange={(e) => setText(e.target.value)} fullWidth multiline minRows={2} size="small" />
      <Typography sx={{ fontSize: 12, fontWeight: 700, mt: 2, mb: 0.8, color: 'text.secondary' }}>
        Success metrics — how you would know
      </Typography>
      {metrics.map((m, i) => (
        <Box key={i} sx={{ display: 'flex', gap: 1, mb: 0.8 }}>
          <TextField value={m} size="small" fullWidth placeholder="e.g. p95 checkout under 2s for 95% of sessions"
            onChange={(e) => setMetrics(metrics.map((x, j) => (j === i ? e.target.value : x)))} />
          <IconButton size="small" aria-label="remove metric"
            onClick={() => setMetrics(metrics.filter((_, j) => j !== i))}>✕</IconButton>
        </Box>
      ))}
      <Button size="small" onClick={() => setMetrics([...metrics, ''])}>+ metric</Button>
      <SaveRow dirty={dirty} onSave={() => onSave({ text, metrics: metrics.filter((m) => m.trim()) })} />
    </Box>
  );
}

// ── Scope ───────────────────────────────────────────────────────────────────────

function ScopeEditor({ plan, onSave }: { plan: Plan; onSave: (v: unknown) => void }) {
  const scope = plan.sections.scope;
  const [ins, setIns] = useState<string[]>(scope.in.length ? scope.in : ['']);
  const [outs, setOuts] = useState(scope.out.length ? scope.out : [{ id: '', text: '' }]);
  useEffect(() => {
    setIns(scope.in.length ? scope.in : ['']);
    setOuts(scope.out.length ? scope.out : [{ id: '', text: '' }]);
  }, [scope]);

  return (
    <Box>
      <Typography sx={{ fontSize: 12, fontWeight: 700, mb: 0.8, color: 'text.secondary' }}>In scope</Typography>
      {ins.map((x, i) => (
        <Box key={i} sx={{ display: 'flex', gap: 1, mb: 0.8 }}>
          <TextField value={x} size="small" fullWidth
            onChange={(e) => setIns(ins.map((v, j) => (j === i ? e.target.value : v)))} />
          <IconButton size="small" aria-label="remove" onClick={() => setIns(ins.filter((_, j) => j !== i))}>✕</IconButton>
        </Box>
      ))}
      <Button size="small" onClick={() => setIns([...ins, ''])}>+ in scope</Button>

      <Typography sx={{ fontSize: 12, fontWeight: 700, mt: 2.4, mb: 0.4, color: 'text.secondary' }}>
        Out of scope
      </Typography>
      <Typography sx={{ fontSize: 12, color: 'text.disabled', mb: 1 }}>
        Each gets an <code>OUT-</code> id. A ticket that traces to one is refused by the scope gate —
        this is the half of the boundary that does the work.
      </Typography>
      {outs.map((o, i) => (
        <Box key={o.id || i} sx={{ display: 'flex', gap: 1, mb: 0.8, alignItems: 'center' }}>
          {o.id && <Chip size="small" label={o.id} sx={{ fontFamily: 'monospace', height: 20, fontSize: 11 }} />}
          <TextField value={o.text} size="small" fullWidth
            onChange={(e) => setOuts(outs.map((v, j) => (j === i ? { ...v, text: e.target.value } : v)))} />
          <IconButton size="small" aria-label="remove" onClick={() => setOuts(outs.filter((_, j) => j !== i))}>✕</IconButton>
        </Box>
      ))}
      <Button size="small" onClick={() => setOuts([...outs, { id: '', text: '' }])}>+ out of scope</Button>

      <SaveRow dirty onSave={() => onSave({
        in: ins.filter((x) => x.trim()),
        out: outs.filter((o) => o.text.trim()),
      })} />
    </Box>
  );
}

// ── Id'd list sections ──────────────────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
  actor: 'Actor', verify: 'Verified by', budget: 'Budget', target: 'Target', mitigation: 'Mitigation',
};
const FIELD_HINT: Record<string, string> = {
  verify: 'a test command, a manual check, a metric',
  budget: 'a number or a named standard — p95 < 300ms, WCAG 2.2 AA',
};

function ListEditor({ meta, items, coverage, onSave }: {
  meta: PlanSectionMeta;
  items: PlanItem[];
  coverage: Map<string, PlanCoverageRow>;
  onSave: (v: unknown) => void;
}) {
  const [rows, setRows] = useState<PlanItem[]>(items);
  useEffect(() => setRows(items), [items]);

  const patch = (i: number, k: string, v: string) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  return (
    <Box>
      {rows.map((row, i) => {
        const cov = row.id ? coverage.get(row.id) : undefined;
        return (
          <Box key={row.id || `new-${i}`}
            sx={{ mb: 1.4, p: 1.4, borderRadius: 1.5, bgcolor: 'action.hover' }}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 1 }}>
              <Chip size="small" label={row.id || 'new'}
                sx={{ fontFamily: 'monospace', height: 20, fontSize: 11, fontWeight: 700 }} />
              {cov && (
                <Tooltip title={cov.tickets.length ? `Worked by ${cov.tickets.join(', ')}` : 'No ticket is working this'}>
                  <Chip size="small" variant="outlined"
                    color={cov.done ? 'success' : cov.tickets.length ? 'default' : 'warning'}
                    label={cov.tickets.length ? `${cov.done ? '✓ ' : ''}${cov.tickets.join(', ')}` : 'no ticket'}
                    sx={{ height: 20, fontSize: 11 }} />
                </Tooltip>
              )}
              <Box sx={{ flexGrow: 1 }} />
              <IconButton size="small" aria-label="remove"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</IconButton>
            </Box>
            <TextField label={meta.itemLabel ?? 'What'} value={row.text ?? ''} size="small" fullWidth
              multiline onChange={(e) => patch(i, 'text', e.target.value)} />
            {meta.fields.map((f) => (
              <TextField key={f} label={FIELD_LABEL[f] ?? f} value={(row[f as keyof PlanItem] as string) ?? ''}
                size="small" fullWidth sx={{ mt: 1 }} helperText={FIELD_HINT[f]}
                onChange={(e) => patch(i, f, e.target.value)} />
            ))}
          </Box>
        );
      })}
      <Button size="small" onClick={() => setRows([...rows, { id: '', text: '' }])}>
        + {meta.itemLabel?.toLowerCase() ?? 'item'}
      </Button>
      <SaveRow dirty onSave={() => onSave(rows.filter((r) => (r.text ?? '').trim()))} />
    </Box>
  );
}

// ── Gaps ────────────────────────────────────────────────────────────────────────

function GapEditor({ items, onTriage }: {
  items: PlanItem[];
  onTriage: (id: string, patch: { status?: string; need?: string; resolvedAs?: string }) => void;
}) {
  const groups = useMemo(() => ({
    required: items.filter((g) => g.need === 'required' && (g.status ?? 'open') === 'open'),
    optional: items.filter((g) => g.need !== 'required' && (g.status ?? 'open') === 'open'),
    closed: items.filter((g) => (g.status ?? 'open') !== 'open'),
  }), [items]);

  if (!items.length) {
    return (
      <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
        None raised. Reporting skills — <code>/atomic-report</code>, <code>/repo-audit</code>,{' '}
        <code>/scale</code>, <code>/data-model</code> — file what this plan doesn&apos;t cover here.
      </Typography>
    );
  }

  return (
    <Box>
      <GapGroup title="Required — the plan is incomplete without these" tone="warning.main"
        rows={groups.required} onTriage={onTriage} />
      <GapGroup title="Optional — worth considering; never affects the percentage" tone="text.secondary"
        rows={groups.optional} onTriage={onTriage} />
      <GapGroup title="Answered" tone="text.disabled" rows={groups.closed} onTriage={onTriage} />
    </Box>
  );
}

function GapGroup({ title, tone, rows, onTriage }: {
  title: string; tone: string; rows: PlanItem[];
  onTriage: (id: string, patch: { status?: string; need?: string; resolvedAs?: string }) => void;
}) {
  if (!rows.length) return null;
  return (
    <Box sx={{ mb: 2 }}>
      <Typography sx={{ fontSize: 12, fontWeight: 700, color: tone, mb: 1 }}>{title}</Typography>
      {rows.map((g) => (
        <Box key={g.id} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 1,
          p: 1.2, borderRadius: 1.5, bgcolor: 'action.hover' }}>
          <Chip size="small" label={g.id} sx={{ fontFamily: 'monospace', height: 20, fontSize: 11 }} />
          <Box sx={{ flexGrow: 1 }}>
            <Typography sx={{ fontSize: 13 }}>{g.text}</Typography>
            <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
              raised by {g.from || 'unknown'}
              {g.resolvedAs ? ` · became ${g.resolvedAs}` : ''}
            </Typography>
          </Box>
          <Select size="small" value={g.status ?? 'open'} sx={{ fontSize: 12, minWidth: 116 }}
            onChange={(e) => onTriage(g.id, { status: e.target.value })}>
            <MenuItem value="open">open</MenuItem>
            <MenuItem value="accepted">accepted</MenuItem>
            <MenuItem value="declined">declined</MenuItem>
          </Select>
          <Select size="small" value={g.need ?? 'optional'} sx={{ fontSize: 12, minWidth: 104 }}
            onChange={(e) => onTriage(g.id, { need: e.target.value })}>
            <MenuItem value="required">required</MenuItem>
            <MenuItem value="optional">optional</MenuItem>
          </Select>
        </Box>
      ))}
    </Box>
  );
}

// ── Shared ──────────────────────────────────────────────────────────────────────

function SaveRow({ dirty, onSave }: { dirty: boolean; onSave: () => void }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.6 }}>
      <Button size="small" variant="contained" disabled={!dirty} onClick={onSave}>Save section</Button>
    </Box>
  );
}
