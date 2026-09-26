import { useEffect, useMemo, useState } from 'react';
import { CssBaseline, ThemeProvider, Box, Button, Typography, IconButton, Select, MenuItem } from '@mui/material';
import { buildTheme, type ThemeMode } from './theme';
import BoardConsole from './BoardConsole';
import PlanPage from './PlanPage';
import RosterPage from './RosterPage';
import DocsPage from './DocsPage';
import HelpPage from './HelpPage';
import TodayPage from './TodayPage';
import ReportsPage from './ReportsPage';
import ValuePage from './ValuePage';
import WelcomeModal from './WelcomeModal';
import { useConfig } from './useConfig';
import { getPortfolioToday, setActiveProject } from './api';
import logoUrl from '../asset/logo.png';

type Tab = 'board' | 'plan' | 'today' | 'roster' | 'value' | 'docs' | 'reports' | 'help';

// Sentinel for "the board this service was started for" in the project picker. A real
// registry name can't collide with it: it isn't a name the registry format produces.
const LOCAL = '·local·';

export default function App() {
  const [mode, setMode] = useState<ThemeMode>('dark');
  const [tab, setTab] = useState<Tab>('board');
  const theme = useMemo(() => buildTheme(mode), [mode]);

  // Portfolio mode (T-003): registry project names, or null when not configured. The picker
  // only renders when a registry is present, so single-board installs see nothing new.
  const [projects, setProjects] = useState<string[] | null>(null);
  const [project, setProject] = useState<string>(LOCAL);
  useEffect(() => {
    getPortfolioToday()
      .then((t) => setProjects(t ? t.projects.map((p) => p.name) : null))
      .catch(() => setProjects(null));
  }, []);

  const pickProject = (name: string) => {
    setActiveProject(name === LOCAL ? null : name);
    setProject(name);
    if (tab === 'today') setTab('board');
  };

  // Which project this board belongs to. Without it the console looks identical for every
  // repo, which matters as soon as you have two of them open. Keyed so it refetches on switch.
  const projectName = useConfig(project)?.name;

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
          {projects ? (
            <>
              <Typography aria-hidden sx={{ color: 'text.disabled', mx: 0.2 }}>/</Typography>
              <Select size="small" value={project} onChange={(e) => pickProject(e.target.value)}
                variant="standard" disableUnderline
                sx={{ fontWeight: 700, color: 'primary.main', letterSpacing: '-0.01em',
                  '& .MuiSelect-select': { py: 0.2 } }}>
                <MenuItem value={LOCAL}>{projectName || 'this board'}</MenuItem>
                {projects.map((p) => <MenuItem key={p} value={p}>{p}</MenuItem>)}
              </Select>
            </>
          ) : projectName && (
            <>
              <Typography aria-hidden sx={{ color: 'text.disabled', mx: 0.2 }}>/</Typography>
              <Typography sx={{ fontWeight: 700, color: 'primary.main', letterSpacing: '-0.01em' }}>
                {projectName}
              </Typography>
            </>
          )}
          <Box sx={{ display: 'flex', gap: 0.5, ml: 2 }}>
            <NavButton active={tab === 'board'} onClick={() => setTab('board')}>Board</NavButton>
            <NavButton active={tab === 'plan'} onClick={() => setTab('plan')}>Plan</NavButton>
            {projects && <NavButton active={tab === 'today'} onClick={() => setTab('today')}>Today</NavButton>}
            <NavButton active={tab === 'roster'} onClick={() => setTab('roster')}>Roster</NavButton>
            <NavButton active={tab === 'value'} onClick={() => setTab('value')}>Value</NavButton>
            <NavButton active={tab === 'docs'} onClick={() => setTab('docs')}>Docs</NavButton>
            <NavButton active={tab === 'reports'} onClick={() => setTab('reports')}>Reports</NavButton>
            <NavButton active={tab === 'help'} onClick={() => setTab('help')}>Help</NavButton>
          </Box>
          <Box sx={{ flexGrow: 1 }} />
          <IconButton size="small" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
            aria-label="toggle theme">{mode === 'dark' ? '☀️' : '🌙'}</IconButton>
        </Box>
        {/* key={project} remounts the page on a scope switch, so every component refetches
            through the new scope without knowing portfolio mode exists. */}
        <Box key={project}>
          {tab === 'board' ? <BoardConsole />
            : tab === 'plan' ? <PlanPage />
            : tab === 'today' ? <TodayPage onOpenProject={pickProject} />
            : tab === 'roster' ? <RosterPage />
            : tab === 'value' ? <ValuePage />
            : tab === 'docs' ? <DocsPage />
            : tab === 'reports' ? <ReportsPage />
            : <HelpPage />}
        </Box>
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
