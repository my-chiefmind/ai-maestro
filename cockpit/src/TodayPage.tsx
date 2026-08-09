import { useEffect, useState } from 'react';
import { Box, Card, Chip, Container, Typography, Button } from '@mui/material';
import type { PortfolioToday } from './types';
import { getPortfolioToday } from './api';

// Portfolio survey: what's ready to run this week, across every registry board (T-003 §3's
// server data, given a face). "Ready" is the validator's own eligibleTickets rule, so a
// ticket shown here is exactly one `npm run validate` counts as eligible on its own board.
export default function TodayPage({ onOpenProject }: { onOpenProject: (name: string) => void }) {
  const [today, setToday] = useState<PortfolioToday | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPortfolioToday()
      .then((t) => {
        if (!t) setError('Portfolio mode is not configured — start the board with --registry <file> or MAESTRO_REGISTRY.');
        else setToday(t);
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  if (error) return <Container sx={{ py: 8 }}><Typography color="error">{error}</Typography></Container>;
  if (!today) return <Container sx={{ py: 8 }}><Typography>Loading portfolio…</Typography></Container>;

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 2 }}>
        <Typography sx={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em' }}>Today</Typography>
        <Typography sx={{ color: 'text.secondary', fontFamily: 'monospace', fontSize: 13 }}>{today.week}</Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        {today.projects.map((p) => (
          <Card key={p.name} sx={{ p: 2.2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <Typography sx={{ fontWeight: 800, fontSize: 16 }}>{p.name}</Typography>
              <Box sx={{ flexGrow: 1 }} />
              {p.setUp
                ? <Button size="small" onClick={() => onOpenProject(p.name)}>Open board</Button>
                : <Chip size="small" label="not set up" color="warning" variant="outlined" />}
            </Box>
            {p.setUp && (
              <>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.6, mb: 1.4 }}>
                  {Object.entries(p.byStatus).map(([status, n]) => (
                    <Chip key={status} size="small" variant="outlined" label={`${status} ${n}`} />
                  ))}
                  {p.total === 0 && <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>Board is empty.</Typography>}
                </Box>
                <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'text.secondary', mb: 0.6 }}>
                  Ready to run ({p.ready.length})
                </Typography>
                {p.ready.length === 0 && (
                  <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>Nothing eligible — everything is blocked, gated, or in flight.</Typography>
                )}
                {p.ready.map((t) => (
                  <Box key={t.id} sx={{ display: 'flex', gap: 1, alignItems: 'baseline', py: 0.4 }}>
                    <Typography sx={{ fontFamily: 'monospace', fontSize: 12.5, color: 'primary.main', flexShrink: 0 }}>{t.id}</Typography>
                    <Typography sx={{ fontSize: 13.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</Typography>
                    {t.priority && <Chip size="small" label={t.priority} sx={{ height: 18, fontSize: 10.5 }} />}
                  </Box>
                ))}
              </>
            )}
          </Card>
        ))}
      </Box>
    </Container>
  );
}
