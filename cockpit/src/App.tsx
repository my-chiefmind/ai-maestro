import { useMemo, useState } from 'react';
import { CssBaseline, ThemeProvider, Box, Button, Typography, IconButton } from '@mui/material';
import { buildTheme, type ThemeMode } from './theme';
import BoardConsole from './BoardConsole';
import RosterPage from './RosterPage';
import DocsPage from './DocsPage';
import HelpPage from './HelpPage';
import WelcomeModal from './WelcomeModal';
import logoUrl from '../asset/logo.png';

type Tab = 'board' | 'roster' | 'docs' | 'help';

export default function App() {
  const [mode, setMode] = useState<ThemeMode>('dark');
  const [tab, setTab] = useState<Tab>('board');
  const theme = useMemo(() => buildTheme(mode), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.2, px: 3, py: 1.4,
          borderBottom: '1px solid', borderColor: 'divider', position: 'sticky', top: 0, zIndex: 20,
          backdropFilter: 'blur(12px)', bgcolor: (t) => `${t.palette.background.paper}e6` }}>
          <Box component="img" src={logoUrl} alt="AI Maestro"
            sx={{ height: 24, width: 24, borderRadius: 1, display: 'block', objectFit: 'cover' }} />
          <Typography sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>AI Maestro</Typography>
          <Box sx={{ display: 'flex', gap: 0.5, ml: 2 }}>
            <NavButton active={tab === 'board'} onClick={() => setTab('board')}>Board</NavButton>
            <NavButton active={tab === 'roster'} onClick={() => setTab('roster')}>Roster</NavButton>
            <NavButton active={tab === 'docs'} onClick={() => setTab('docs')}>Docs</NavButton>
            <NavButton active={tab === 'help'} onClick={() => setTab('help')}>Help</NavButton>
          </Box>
          <Box sx={{ flexGrow: 1 }} />
          <IconButton size="small" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
            aria-label="toggle theme">{mode === 'dark' ? '☀️' : '🌙'}</IconButton>
        </Box>
        {tab === 'board' ? <BoardConsole /> : tab === 'roster' ? <RosterPage /> : tab === 'docs' ? <DocsPage /> : <HelpPage />}
        <WelcomeModal />
      </Box>
    </ThemeProvider>
  );
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button size="small" onClick={onClick}
      sx={{ minWidth: 0, px: 1.4, color: active ? 'primary.main' : 'text.secondary',
        bgcolor: active ? 'action.selected' : 'transparent', fontWeight: active ? 700 : 500 }}>
      {children}
    </Button>
  );
}
