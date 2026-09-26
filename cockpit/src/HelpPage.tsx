import { useEffect, useState } from 'react';
import { Box, Button, Card, Container, Tab, Tabs, Typography, useTheme } from '@mui/material';
import CheatSheet from './CheatSheet';
import { helpGuideUrl, hasHelpGuide } from './api';

// The Help tab: the cheat sheet you need on day one, plus the long-form guide (docs/help.html)
// that explains the model behind it. The guide is HTML, so the Markdown docs browser could not
// carry it and it shipped unreachable — here it loads in a sandboxed iframe, exactly like an
// .html report: no scripts, no same-origin, because it is a document and not an app.
export default function HelpPage() {
  const [tab, setTab] = useState<'cheatsheet' | 'guide'>('cheatsheet');
  const [guide, setGuide] = useState<boolean | null>(null);
  // The sandbox is opaque both ways, so the guide can't be told the theme after it loads —
  // it rides in the URL, and toggling the console changes the src, which reloads the frame.
  const mode = useTheme().palette.mode;

  // A kit vendored before the guide existed simply doesn't have it — show the cheat sheet
  // alone rather than a tab leading to an empty frame.
  useEffect(() => { hasHelpGuide().then(setGuide); }, []);

  return (
    <Container maxWidth={tab === 'guide' ? false : 'md'} sx={{ py: 4 }}>
      <Box sx={{ mb: 3 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase',
          color: 'primary.main', mb: 0.6 }}>Help &amp; cheat sheet 🎼</Typography>
        <Typography variant="h1" sx={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em' }}>
          Getting started
        </Typography>
      </Box>

      {guide && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ minHeight: 40 }}>
            <Tab value="cheatsheet" label="Cheat sheet" sx={{ minHeight: 40, textTransform: 'none', fontWeight: 700 }} />
            <Tab value="guide" label="How it works" sx={{ minHeight: 40, textTransform: 'none', fontWeight: 700 }} />
          </Tabs>
          {tab === 'guide' && (
            <Button size="small" href={helpGuideUrl(mode)} target="_blank" rel="noopener noreferrer"
              sx={{ ml: 'auto', textTransform: 'none' }}>
              Open in a new tab
            </Button>
          )}
        </Box>
      )}

      {tab === 'guide' && guide ? (
        <Card sx={{ p: 0, overflow: 'hidden' }}>
          {/* Sandboxed: no scripts, no same-origin. */}
          {/* `key` forces a remount on toggle so the frame reloads at the new theme rather
              than keeping the document it already parsed. bgcolor matches the guide's own
              ground, or a hardcoded white flashes behind it on every dark-mode load. */}
          <Box component="iframe" key={mode} src={helpGuideUrl(mode)} sandbox="" title="How AI Maestro works"
            sx={{ display: 'block', width: '100%', height: 'calc(100vh - 200px)', border: 0,
              bgcolor: mode === 'dark' ? '#141119' : '#f7f5fa' }} />
        </Card>
      ) : (
        <Card sx={{ p: { xs: 2.5, md: 4 } }}>
          <CheatSheet />
        </Card>
      )}
    </Container>
  );
}
