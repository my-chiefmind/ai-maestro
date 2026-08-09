import { useEffect, useState } from 'react';
import { Box, Card, Container, Typography } from '@mui/material';
import type { ReportInfo } from './types';
import { getReports, getReportHtml, reportFileUrl } from './api';

// Generated reports under board/reports/, served read-only (T-003 §5). Markdown renders
// through the same neutered pipeline as docs; HTML reports load in a sandboxed iframe so
// agent-generated markup never runs in the cockpit's origin.
export default function ReportsPage() {
  const [reports, setReports] = useState<ReportInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<ReportInfo | null>(null);
  const [html, setHtml] = useState('');

  useEffect(() => {
    getReports()
      .then((r) => { setReports(r); setSel(r[0] ?? null); })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  useEffect(() => {
    if (!sel || !sel.name.endsWith('.md')) { setHtml(''); return; }
    getReportHtml(sel.name)
      .then(setHtml)
      .catch((e) => setHtml(`<p>Could not load this report: ${String(e.message || e)}</p>`));
  }, [sel]);

  if (error) return <Container sx={{ py: 8 }}><Typography color="error">{error}</Typography></Container>;
  if (!reports) return <Container sx={{ py: 8 }}><Typography>Loading reports…</Typography></Container>;
  if (reports.length === 0) {
    return (
      <Container sx={{ py: 8 }}>
        <Typography sx={{ color: 'text.secondary' }}>
          No reports yet. Files an agent writes to <code>board/reports/</code> (.md or .html) show up here.
        </Typography>
      </Container>
    );
  }

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '280px minmax(0, 1fr)' }, gap: 2, alignItems: 'start' }}>
        <Card sx={{ p: 0, overflow: 'hidden', position: { md: 'sticky' }, top: 76 }}>
          <Typography sx={{ px: 1.6, pt: 1.6, pb: 0.6, fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'text.secondary' }}>
            board/reports
          </Typography>
          {reports.map((r) => (
            <Box key={r.name} component="button" onClick={() => setSel(r)}
              sx={{ display: 'block', width: '100%', textAlign: 'left', border: 0, cursor: 'pointer',
                px: 1.6, py: 0.9, fontSize: 13, lineHeight: 1.35,
                bgcolor: sel?.name === r.name ? 'action.selected' : 'transparent',
                color: sel?.name === r.name ? 'text.primary' : 'text.secondary',
                fontWeight: sel?.name === r.name ? 700 : 400,
                borderLeft: '2px solid', borderColor: sel?.name === r.name ? 'primary.main' : 'transparent',
                '&:hover': { bgcolor: 'action.hover', color: 'text.primary' } }}>
              <Box sx={{ fontFamily: 'monospace' }}>{r.name}</Box>
              <Box sx={{ fontSize: 11, color: 'text.disabled' }}>{new Date(r.mtime).toLocaleString()}</Box>
            </Box>
          ))}
        </Card>

        <Card sx={{ p: sel?.name.endsWith('.html') ? 0 : { xs: 2.5, md: 4 }, minWidth: 0, overflow: 'hidden' }}>
          {sel?.name.endsWith('.html') ? (
            // Sandboxed: no scripts, no same-origin — the report is a document, not an app.
            <Box component="iframe" src={reportFileUrl(sel.name)} sandbox="" title={sel.name}
              sx={{ display: 'block', width: '100%', height: 'calc(100vh - 140px)', border: 0, bgcolor: '#fff' }} />
          ) : (
            <Box sx={{ fontSize: 15, lineHeight: 1.65, color: 'text.primary',
              '& table': { borderCollapse: 'collapse', display: 'block', overflowX: 'auto', width: '100%' },
              '& th, & td': { border: '1px solid', borderColor: 'divider', px: 1.4, py: 0.8, textAlign: 'left', fontSize: 13.5 },
              '& code': { fontFamily: 'monospace', fontSize: 13 },
              '& img': { maxWidth: '100%' } }}
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </Card>
      </Box>
    </Container>
  );
}
