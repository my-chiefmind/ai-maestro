import { useState } from 'react';
import { Dialog, DialogContent, DialogActions, Box, Typography, Button } from '@mui/material';
import CheatSheet from './CheatSheet';

const SEEN_KEY = 'maestro.welcome.v1';

// Shown once, the first time someone opens the board — a friendly "you're set up, here's what
// to do next" cheat sheet. Dismissal is remembered in localStorage; the same content lives on
// the Help tab for later. Bump SEEN_KEY to re-show it after a meaningful onboarding change.
export default function WelcomeModal() {
  const [open, setOpen] = useState(() => {
    try { return !localStorage.getItem(SEEN_KEY); } catch { return true; }
  });
  const close = () => {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode — just close */ }
    setOpen(false);
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth
      slotProps={{ paper: { sx: { borderRadius: 3, overflow: 'hidden' } } }}>
      <Box sx={{ px: 3, pt: 3, pb: 2.2, background: 'linear-gradient(135deg, rgba(139,140,240,0.16), rgba(240,165,200,0.14))',
        borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography sx={{ fontSize: 12, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase',
          color: 'primary.main', mb: 0.6 }}>Welcome to AI Maestro 🎼</Typography>
        <Typography variant="h6" sx={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.02em' }}>
          You're set up. Here's your first move.
        </Typography>
      </Box>
      <DialogContent sx={{ px: 3, py: 2.6 }}>
        <CheatSheet compact />
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, borderTop: '1px solid', borderColor: 'divider' }}>
        <Typography sx={{ flexGrow: 1, fontSize: 12, color: 'text.disabled' }}>
          You can reopen this any time from the <b>Help</b> tab.
        </Typography>
        <Button variant="contained" onClick={close}>Got it — let's go</Button>
      </DialogActions>
    </Dialog>
  );
}
