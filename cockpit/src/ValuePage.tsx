import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Card, Chip, Container, LinearProgress, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import type { UsageBucket, UsageReport, UsageTicket, UsageTokens } from './types';
import { getUsage, usageExportUrl } from './api';

// The Value page: what each ticket cost in time and tokens, and how much of that is measured
// rather than inferred. Every number here is served by scripts/usage-core.mjs — this file
// formats, it never computes — so the page, the CSV export, the snapshot and `maestro usage`
// cannot quote different figures for the same ticket.
//
// Two honesty rules shape the layout. Provenance is visible per row, not buried in a footnote:
// a measured ticket and an inferred one never look alike. And unattributed work gets its own
// panel with its reasons, because spreading it across tickets would make every row look
// precise and be wrong.

const DIMENSIONS = ['model', 'agent', 'runtime', 'stage', 'date'] as const;
type Dimension = typeof DIMENSIONS[number];

const DIMENSION_HINT: Record<Dimension, string> = {
  model: 'Which model tier the tokens actually went to.',
  agent: 'The main session versus each subagent the roster spawned.',
  runtime: 'Claude Code or Codex. Historical rows are Claude only — Codex writes no local transcript to read.',
  stage: 'Pipeline stage. Only measured runs carry one; inferred turns show as unknown.',
  date: 'Day by day, UTC.',
};

const REASON_LABEL: Record<string, string> = {
  'no-ticket-in-session': 'No ticket named anywhere in the session',
  'before-first-signal': "Before the session's first ticket signal",
  'signal-expired': 'Signal went stale with several tickets in play',
};

const TOKEN_CLASSES: Array<{ key: keyof UsageTokens; label: string; color: string }> = [
  { key: 'input', label: 'Input', color: '#3aa7b0' },
  { key: 'output', label: 'Output', color: '#1d6b76' },
  { key: 'cacheWrite', label: 'Cache write', color: '#7fb3b6' },
  { key: 'cacheRead', label: 'Cache read', color: '#4a5b5e' },
];

function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  if (!ms) return '—';
  const h = ms / 3600000;
  if (h >= 48) return `${(h / 24).toFixed(1)}d`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  const m = ms / 60000;
  if (m >= 1) return `${m.toFixed(0)}m`;
  return `${Math.round(ms / 1000)}s`;
}

const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');

// A stacked proportion bar. Shape compares tickets of very different sizes; the absolute
// figure sits in the column beside it.
function TokenBar({ tokens, width = 118 }: { tokens: UsageTokens; width?: number }) {
  const total = tokens.total || 1;
  return (
    <Tooltip title={TOKEN_CLASSES.map((c) => `${c.label} ${fmtTokens(tokens[c.key])}`).join(' · ')}>
      <Box sx={{ display: 'flex', width, height: 9, borderRadius: 0.5, overflow: 'hidden', bgcolor: 'action.hover' }}>
        {TOKEN_CLASSES.map((c) => {
          const pct = (tokens[c.key] / total) * 100;
          return pct > 0.05 ? <Box key={c.key} sx={{ width: `${pct}%`, bgcolor: c.color }} /> : null;
        })}
      </Box>
    </Tooltip>
  );
}

// Provenance as form, not just a word: solid = measured from run telemetry, dashed = inferred
// from transcripts, split = both. Someone scanning the column sees the difference without
// reading it.
function TimingStripe({ timing }: { timing: UsageTicket['timing'] }) {
  const dashed = 'repeating-linear-gradient(180deg, currentColor 0 3px, transparent 3px 6px)';
  return (
    <Tooltip title={timing === 'exact' ? 'Measured from run telemetry'
      : timing === 'mixed' ? 'Part measured, part inferred from transcripts'
        : 'Inferred from session transcripts'}>
      <Box component="span" sx={{
        display: 'inline-block', width: 3, height: 18, mr: 1, verticalAlign: 'middle', borderRadius: 0.5,
        color: timing === 'estimated' ? 'text.disabled' : 'primary.main',
        background: timing === 'exact' ? 'currentColor'
          : timing === 'mixed' ? `linear-gradient(180deg, currentColor 0 50%, transparent 50%), ${dashed}`
            : dashed,
      }} />
    </Tooltip>
  );
}

const CONFIDENCE_COLOR: Record<string, 'success' | 'primary' | 'warning' | 'default'> = {
  exact: 'success', high: 'primary', medium: 'warning', unassigned: 'default',
};

function Meter({ label, value, note, accent }: { label: string; value: string; note?: string; accent?: boolean }) {
  return (
    <Card sx={{ p: 1.8, flex: '1 1 165px', minWidth: 150 }}>
      <Typography sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'text.secondary' }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 26, fontWeight: 800, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums', color: accent ? 'primary.main' : 'text.primary' }}>
        {value}
      </Typography>
      {note && <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{note}</Typography>}
    </Card>
  );
}

function BucketTable({ rows, dense }: { rows: UsageBucket[]; dense?: boolean }) {
  const max = rows[0]?.tokens.total || 1;
  return (
    <Table size="small">
      <TableBody>
        {rows.slice(0, dense ? 6 : 12).map((r) => (
          <TableRow key={r.key}>
            <TableCell sx={{ border: 0, py: 0.35, fontSize: 13 }}>{shortModel(r.key)}</TableCell>
            <TableCell align="right" sx={{ border: 0, py: 0.35, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
              {fmtTokens(r.tokens.total)}
            </TableCell>
            <TableCell align="right" sx={{ border: 0, py: 0.35, fontSize: 13, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
              {fmtDuration(r.estimatedActiveMs + r.exactMs)}
            </TableCell>
            <TableCell sx={{ border: 0, py: 0.35, width: '32%' }}>
              <LinearProgress variant="determinate" value={(r.tokens.total / max) * 100}
                sx={{ height: 6, borderRadius: 1, opacity: 0.55 }} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function ValuePage() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dim, setDim] = useState<Dimension>('model');
  const [open, setOpen] = useState<string | null>(null);

  const load = (refresh = false) => {
    setBusy(true);
    getUsage(refresh)
      .then((r) => { setReport(r); setError(null); })
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setBusy(false));
  };
  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const attributedPct = useMemo(() => {
    if (!report || !report.totals.tokens.total) return 0;
    return ((report.totals.tokens.total - report.unassigned.tokens.total) / report.totals.tokens.total) * 100;
  }, [report]);

  if (error) return <Container sx={{ py: 8 }}><Typography color="error">{error}</Typography></Container>;
  if (!report) return <Container sx={{ py: 8 }}><Typography>Reading usage…</Typography></Container>;

  const { coverage: c, totals: t } = report;
  const workingMs = t.estimatedActiveMs + t.exactMs;

  return (
    <Container maxWidth="xl" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>Value</Typography>
        <Typography sx={{ color: 'text.secondary', fontSize: 14, maxWidth: '70ch' }}>
          What each ticket cost, start to finish — time, tokens, and which models and agents spent them.
          Rows measured by run telemetry are marked; the rest are inferred from local session transcripts
          and carry the confidence of that inference.
        </Typography>
        <Typography sx={{ mt: 0.8, fontSize: 11.5, color: 'text.disabled', fontFamily: 'monospace' }}>
          {report.dateRange.from?.slice(0, 10) || '—'} → {report.dateRange.to?.slice(0, 10) || '—'}
          {' · '}transcripts {report.enabled.transcripts ? `on (${c.transcriptSessions} sessions)` : 'off — opt-in'}
          {' · '}{c.exactRuns} measured runs
          {' · '}generated {report.generatedAt.slice(0, 16).replace('T', ' ')}Z
        </Typography>
      </Box>

      {!report.enabled.transcripts && (
        <Card sx={{ p: 2, borderLeft: '3px solid', borderColor: 'warning.main' }}>
          <Typography sx={{ fontSize: 14, fontWeight: 700 }}>Transcript reading is off</Typography>
          <Typography sx={{ fontSize: 13.5, color: 'text.secondary', maxWidth: '78ch' }}>
            Only measured <code>maestro run</code> telemetry is shown. To also reconstruct the history already on
            disk, set <code>"usage": {'{'} "scanTranscripts": true {'}'}</code> in <code>config.json</code>, or start the
            cockpit with <code>MAESTRO_USAGE_SCAN=1</code>. Reading is local and read-only, and only aggregates are
            kept — never prompts, responses, commands or source.
          </Typography>
        </Card>
      )}

      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Meter accent label="Total tokens" value={fmtTokens(t.tokens.total)} note={`${fmtTokens(t.tokens.thinking)} reasoning`} />
        <Meter label="Agent working time" value={fmtDuration(workingMs)} note="idle gaps excluded" />
        <Meter label="Tied to a ticket" value={`${attributedPct.toFixed(0)}%`} note={`${fmtTokens(t.tokens.total - report.unassigned.tokens.total)} of ${fmtTokens(t.tokens.total)}`} />
        <Meter label="Tickets with usage" value={String(c.ticketsWithUsage)} note={`of ${c.ticketsOnBoard} on the board`} />
        <Meter label="Turns" value={t.turns.toLocaleString('en-US')} note={`${c.exactRuns} measured runs`} />
      </Stack>

      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
        <Button size="small" variant="outlined" disabled={busy} onClick={() => load(true)}>
          {busy ? 'Reading…' : 'Refresh'}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>Export</Typography>
        <Button size="small" href={usageExportUrl('csv', 'tickets')}>CSV</Button>
        <Button size="small" href={usageExportUrl('json')}>JSON</Button>
        <Tooltip title="A self-contained page with these aggregates — safe to share, no transcript content in it">
          <Button size="small" href={usageExportUrl('html')}>Snapshot</Button>
        </Tooltip>
      </Stack>

      <Card sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 900 }}>
          <TableHead>
            <TableRow>
              {['Ticket', 'Name', 'Confidence', 'Tokens', 'Mix', 'Working', 'Elapsed', 'Turns', 'Models'].map((h) => (
                <TableCell key={h} sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'text.secondary', whiteSpace: 'nowrap' }}>
                  {h}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {report.tickets.length === 0 && (
              <TableRow><TableCell colSpan={9} sx={{ color: 'text.secondary', py: 4 }}>
                No usage could be tied to a ticket yet.
              </TableCell></TableRow>
            )}
            {report.tickets.map((tk) => (
              <Fragment key={tk.id}>
                <TableRow hover sx={{ cursor: 'pointer' }} onClick={() => setOpen(open === tk.id ? null : tk.id)}>
                  <TableCell sx={{ whiteSpace: 'nowrap', fontFamily: 'monospace', fontWeight: 600 }}>
                    <TimingStripe timing={tk.timing} />{tk.id}
                  </TableCell>
                  <TableCell sx={{ minWidth: 220 }}>
                    <Typography sx={{ fontSize: 13.5, lineHeight: 1.3 }}>{tk.name || <em>untitled</em>}</Typography>
                    <Typography sx={{ fontSize: 10.5, color: 'text.disabled', fontFamily: 'monospace' }}>
                      {tk.area || '—'} · {tk.status || '—'}{tk.boardModel ? ` · board model ${tk.boardModel}` : ''}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Tooltip title={tk.evidence.join(', ') || 'no evidence recorded'}>
                      <Chip size="small" variant="outlined" label={tk.confidence} color={CONFIDENCE_COLOR[tk.confidence] || 'default'} sx={{ fontSize: 10, height: 20 }} />
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {fmtTokens(tk.metrics.tokens.total)}
                  </TableCell>
                  <TableCell><TokenBar tokens={tk.metrics.tokens} /></TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {fmtDuration(tk.metrics.estimatedActiveMs + tk.metrics.exactMs)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary', whiteSpace: 'nowrap' }}>
                    {tk.cycleMs !== null ? fmtDuration(tk.cycleMs) : fmtDuration(tk.metrics.spanMs)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>
                    {tk.metrics.turns || '—'}{tk.metrics.runs ? ` +${tk.metrics.runs}r` : ''}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {tk.breakdown.model.slice(0, 3).map((m) => (
                      <Chip key={m.key} size="small" variant="outlined" label={shortModel(m.key)} sx={{ fontSize: 9.5, height: 18, mr: 0.4 }} />
                    ))}
                  </TableCell>
                </TableRow>
                {open === tk.id && (
                  <TableRow>
                    <TableCell colSpan={9} sx={{ bgcolor: 'action.hover', py: 1.5 }}>
                      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0,1fr))' }, gap: 2 }}>
                        {(['agent', 'model', 'date'] as Dimension[]).map((d) => (
                          <Box key={d}>
                            <Typography sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'text.secondary', mb: 0.5 }}>
                              By {d}
                            </Typography>
                            <BucketTable rows={tk.breakdown[d] || []} dense />
                          </Box>
                        ))}
                      </Box>
                      <Typography sx={{ mt: 1, fontSize: 11.5, color: 'text.disabled', fontFamily: 'monospace' }}>
                        evidence: {tk.evidence.join(', ') || '—'}
                        {tk.cycleMs !== null && ` · measured cycle ${fmtDuration(tk.cycleMs)}`}
                        {` · elapsed ${fmtDuration(tk.metrics.spanMs)}`}
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Box>
        <ToggleButtonGroup exclusive size="small" value={dim} onChange={(_, v) => v && setDim(v)} sx={{ mb: 1 }}>
          {DIMENSIONS.map((d) => <ToggleButton key={d} value={d} sx={{ textTransform: 'none', px: 1.5 }}>{d}</ToggleButton>)}
        </ToggleButtonGroup>
        <Card sx={{ p: 2 }}>
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mb: 1 }}>{DIMENSION_HINT[dim]}</Typography>
          <BucketTable rows={report.breakdown[dim] || []} />
          <Box sx={{ mt: 1 }}>
            <Button size="small" href={usageExportUrl('csv', dim)}>Export this view as CSV</Button>
          </Box>
        </Card>
      </Box>

      <Card sx={{ p: 2, borderLeft: '3px solid', borderColor: 'primary.main' }}>
        <Typography sx={{ fontSize: 14, fontWeight: 700 }}>What isn&apos;t counted</Typography>
        <Typography sx={{ fontSize: 13.5, color: 'text.secondary', maxWidth: '78ch' }}>
          <strong>{fmtTokens(report.unassigned.tokens.total)} tokens over {report.unassigned.turns.toLocaleString('en-US')} turns</strong>{' '}
          could not be tied to a ticket. It is reported rather than distributed — spreading it across tickets
          would make every row above look precise and be wrong. The reasons mean different things: work that
          never named a ticket is a fact about how the work ran, not a limit of the reading.
        </Typography>
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.4, maxWidth: 560 }}>
          {Object.entries(c.unassignedReasons || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
            <Box key={k} sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderBottom: '1px dotted', borderColor: 'divider', pb: 0.3 }}>
              <span>{REASON_LABEL[k] || k}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.75 }}>{v.toLocaleString('en-US')} turns</span>
            </Box>
          ))}
        </Box>
      </Card>

      <Typography sx={{ fontSize: 11.5, color: 'text.disabled', fontFamily: 'monospace', maxWidth: '92ch' }}>
        Working time counts gaps between turns capped at 5 minutes; longer gaps are idle, not agent work.
        Reasoning tokens are a subset of output and are not added to the total. Token counts only — no cost is
        shown, because rates vary by account and a subscription has no per-token price.
      </Typography>
    </Container>
  );
}
