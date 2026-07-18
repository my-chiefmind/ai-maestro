import { Box, Card, Container, Typography } from '@mui/material';
import CheatSheet from './CheatSheet';

// The always-available cheat sheet — same content as the first-run welcome modal, reachable
// any time from the Help tab in the nav bar.
export default function HelpPage() {
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box sx={{ mb: 3 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase',
          color: 'primary.main', mb: 0.6 }}>Help &amp; cheat sheet 🎼</Typography>
        <Typography variant="h1" sx={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em' }}>
          Getting started
        </Typography>
      </Box>
      <Card sx={{ p: { xs: 2.5, md: 4 } }}>
        <CheatSheet />
      </Card>
    </Container>
  );
}
