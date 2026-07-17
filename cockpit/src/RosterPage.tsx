import { useEffect, useState } from 'react';
import { Box, Card, Container, Typography } from '@mui/material';
import type { Roster } from './types';
import { getRoster } from './api';

// Read-only view of the project's agents and skills — the "one place" a team can see the
// roster that its tickets route work through. Sourced from the rendered .claude/ (or the
// kit's own agents/ + skills/ as a fallback).
export default function RosterPage() {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getRoster().then(setRoster).catch((e) => setError(String(e.message || e))); }, []);

  if (error) return <Container sx={{ py: 8 }}><Typography color="error">{error}</Typography></Container>;
  if (!roster) return <Container sx={{ py: 8 }}><Typography>Loading roster…</Typography></Container>;

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <Section title="Agents" subtitle="Roles a ticket’s agent_plan can route work to">
        {roster.agents.map((a) => (
          <Card key={a.code} sx={{ p: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.5 }}>
              <Typography sx={{ fontWeight: 700 }}>{a.name}</Typography>
              <Typography sx={{ fontFamily: 'monospace', fontSize: 12, color: 'primary.main' }}>{a.code}</Typography>
            </Box>
            <Typography variant="body2" color="text.secondary">{a.description}</Typography>
          </Card>
        ))}
      </Section>

      <Section title="Skills" subtitle="Reusable procedures agents invoke">
        {roster.skills.map((s) => (
          <Card key={s.name} sx={{ p: 2 }}>
            <Typography sx={{ fontWeight: 700, mb: 0.5 }}>{s.name}</Typography>
            <Typography variant="body2" color="text.secondary">{s.description}</Typography>
          </Card>
        ))}
      </Section>
    </Container>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="h6" sx={{ fontWeight: 800 }}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{subtitle}</Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' }, gap: 1.5 }}>
        {children}
      </Box>
    </Box>
  );
}
