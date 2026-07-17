import { useEffect, useState } from 'react';
import { Box, Card, Container, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { DocSection } from './types';
import { getDocs, getDocHtml } from './api';

// The kit's guides, reference, agents, and skills — read in place from the cockpit.
// Markdown is rendered server-side (/api/docs/render) and dropped in with themed styles.
export default function DocsPage() {
  const [sections, setSections] = useState<DocSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getDocs()
      .then((d) => {
        setSections(d.sections);
        const first = d.sections[0]?.files[0]?.path ?? null;
        setSel(first);
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  useEffect(() => {
    if (!sel) return;
    setLoading(true);
    getDocHtml(sel)
      .then(setHtml)
      .catch((e) => setHtml(`<p>Could not load this doc: ${String(e.message || e)}</p>`))
      .finally(() => setLoading(false));
  }, [sel]);

  if (error) return <Container sx={{ py: 8 }}><Typography color="error">{error}</Typography></Container>;
  if (!sections) return <Container sx={{ py: 8 }}><Typography>Loading docs…</Typography></Container>;

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '248px minmax(0, 1fr)' }, gap: 2, alignItems: 'start' }}>
        <Card sx={{ p: 0, overflow: 'hidden', position: { md: 'sticky' }, top: 76 }}>
          {sections.map((s) => (
            <Box key={s.key}>
              <Typography sx={{ px: 1.6, pt: 1.6, pb: 0.6, fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'text.secondary' }}>{s.label}</Typography>
              {s.files.map((f) => (
                <Box key={f.path} component="button" onClick={() => setSel(f.path)}
                  sx={{ display: 'block', width: '100%', textAlign: 'left', border: 0, cursor: 'pointer',
                    px: 1.6, py: 0.9, fontSize: 13, lineHeight: 1.35,
                    bgcolor: sel === f.path ? 'action.selected' : 'transparent',
                    color: sel === f.path ? 'text.primary' : 'text.secondary',
                    fontWeight: sel === f.path ? 700 : 400,
                    borderLeft: '2px solid', borderColor: sel === f.path ? 'primary.main' : 'transparent',
                    '&:hover': { bgcolor: 'action.hover', color: 'text.primary' } }}>
                  {f.title}
                </Box>
              ))}
            </Box>
          ))}
        </Card>

        <Card sx={{ p: { xs: 2.5, md: 4 }, minWidth: 0 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>{sel}</Typography>
          <Box sx={{ ...mdSx, opacity: loading ? 0.5 : 1, transition: 'opacity .12s' }}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: html }} />
        </Card>
      </Box>
    </Container>
  );
}

// Styles for the server-rendered Markdown, tuned to the cockpit theme.
const mdSx = {
  mt: 1,
  fontSize: 15,
  lineHeight: 1.65,
  color: 'text.primary',
  '& h1': { fontSize: 30, fontWeight: 800, mt: 1, mb: 2, letterSpacing: '-.02em' },
  '& h2': { fontSize: 22, fontWeight: 800, mt: 4, mb: 1.5, pb: 0.6, borderBottom: '1px solid', borderColor: 'divider' },
  '& h3': { fontSize: 17, fontWeight: 700, mt: 3, mb: 1 },
  '& p': { my: 1.4 },
  '& ul, & ol': { my: 1.4, pl: 3 },
  '& li': { my: 0.5 },
  '& a': { color: 'primary.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } },
  '& strong': { fontWeight: 700 },
  '& code': (t: any) => ({ px: 0.7, py: 0.2, borderRadius: 1, fontSize: 13, fontFamily: 'monospace', bgcolor: alpha(t.palette.text.primary, 0.08) }),
  '& pre': (t: any) => ({ my: 2, p: 2, borderRadius: 2, overflowX: 'auto', bgcolor: alpha(t.palette.text.primary, 0.06), border: '1px solid', borderColor: 'divider' }),
  '& pre code': { p: 0, bgcolor: 'transparent', fontSize: 13, lineHeight: 1.6 },
  '& blockquote': { my: 2, ml: 0, pl: 2, borderLeft: '3px solid', borderColor: 'primary.main', color: 'text.secondary' },
  '& table': { my: 2, borderCollapse: 'collapse', display: 'block', overflowX: 'auto', width: '100%' },
  '& th, & td': { border: '1px solid', borderColor: 'divider', px: 1.4, py: 0.8, textAlign: 'left', fontSize: 13.5 },
  '& th': (t: any) => ({ bgcolor: alpha(t.palette.text.primary, 0.05), fontWeight: 700 }),
  '& img': { maxWidth: '100%', borderRadius: 2 },
  '& hr': { my: 3, border: 0, borderTop: '1px solid', borderColor: 'divider' },
} as const;
