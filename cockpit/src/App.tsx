import { useMemo, useState } from 'react';
import { CssBaseline, ThemeProvider, Box, Typography, IconButton } from '@mui/material';
import { buildTheme, type ThemeMode } from './theme';
import BoardConsole from './BoardConsole';

export default function App() {
  const [mode, setMode] = useState<ThemeMode>('dark');
  const theme = useMemo(() => buildTheme(mode), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.2, px: 3, py: 1.4,
          borderBottom: '1px solid', borderColor: 'divider', position: 'sticky', top: 0, zIndex: 20,
          backdropFilter: 'blur(12px)', bgcolor: (t) => `${t.palette.background.paper}e6` }}>
          <Typography sx={{ fontSize: 18 }}>🎼</Typography>
          <Typography sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>Maestro</Typography>
          <Typography variant="caption" color="text.secondary">board console</Typography>
          <Box sx={{ flexGrow: 1 }} />
          <IconButton size="small" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
            aria-label="toggle theme">{mode === 'dark' ? '☀️' : '🌙'}</IconButton>
        </Box>
        <BoardConsole />
      </Box>
    </ThemeProvider>
  );
}
