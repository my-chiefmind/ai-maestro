import { createTheme, alpha } from '@mui/material/styles';

export type ThemeMode = 'light' | 'dark';

// Maestro palette: deep indigo/violet accent (the conductor) over cool neutrals.
const tokens = {
  dark: {
    bg: '#0c0d14', surface: '#14151f', surface2: '#1b1d2a', surface3: '#262a3b',
    border: 'rgba(140,150,200,0.15)', border2: 'rgba(140,150,200,0.26)',
    tx1: '#e7e9f4', tx2: '#9aa0bd', tx3: '#6b708c',
  },
  light: {
    bg: '#f6f7fb', surface: '#ffffff', surface2: '#eef0f6', surface3: '#e2e5ee',
    border: 'rgba(120,130,170,0.20)', border2: 'rgba(120,130,170,0.34)',
    tx1: '#141626', tx2: '#4a4f6b', tx3: '#9096b0',
  },
  green: '#10b981', amber: '#f59e0b', red: '#f43f5e',
  radius: 8, radiusL: 14,
};

export function buildTheme(mode: ThemeMode) {
  const isDark = mode === 'dark';
  const surf = isDark ? tokens.dark : tokens.light;
  const accent = isDark ? '#8b8cf0' : '#5b5bd6';       // indigo
  const accentDark = isDark ? '#7373e0' : '#4747c4';
  const accentLight = isDark ? '#a5a6f5' : '#7373e0';
  const hover = isDark ? alpha('#ffffff', 0.06) : alpha('#141626', 0.035);

  return createTheme({
    palette: {
      mode,
      primary: { main: accent, light: accentLight, dark: accentDark, contrastText: isDark ? '#0c0d14' : '#ffffff' },
      secondary: { main: isDark ? '#f0a5c8' : '#c44780', contrastText: '#fff' },
      background: { default: surf.bg, paper: surf.surface },
      text: { primary: surf.tx1, secondary: surf.tx2, disabled: surf.tx3 },
      success: { main: tokens.green, light: '#34d399', dark: '#059669' },
      warning: { main: tokens.amber, light: '#fbbf24', dark: '#d97706' },
      error: { main: tokens.red, light: '#fb7185', dark: '#e11d48' },
      info: { main: accentLight },
      divider: surf.border,
    },
    typography: {
      fontSize: 13,
      fontFamily: "Inter, Roboto, 'Helvetica Neue', Arial, sans-serif",
      h6: { fontSize: '15px', fontWeight: 800, letterSpacing: '-0.01em' },
      button: { fontSize: '12px', textTransform: 'none', fontWeight: 600 },
      overline: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.09em', fontWeight: 700 },
    },
    shape: { borderRadius: tokens.radius },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          '::-webkit-scrollbar': { width: 8, height: 8 },
          '::-webkit-scrollbar-track': { background: 'transparent' },
          '::-webkit-scrollbar-thumb': { background: surf.surface3, borderRadius: 999 },
          body: { background: surf.bg },
        },
      },
      MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: tokens.radius } } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' }, outlined: { borderColor: surf.border } } },
      MuiCard: { styleOverrides: { root: { backgroundImage: 'none', border: `1px solid ${surf.border}`, boxShadow: 'none', borderRadius: tokens.radiusL } } },
      MuiDrawer: { styleOverrides: { paper: { backgroundImage: 'none' } } },
      MuiTextField: { defaultProps: { size: 'small' }, styleOverrides: { root: { '& .MuiOutlinedInput-notchedOutline': { borderColor: surf.border2 } } } },
      MuiSelect: { defaultProps: { size: 'small' } },
      MuiDivider: { styleOverrides: { root: { borderColor: surf.border } } },
      MuiTableRow: { styleOverrides: { root: { '&:hover td': { background: hover } } } },
    },
  });
}
