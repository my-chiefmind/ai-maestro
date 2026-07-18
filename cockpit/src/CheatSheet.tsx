import { useState } from 'react';
import { Box, Typography, Tooltip, IconButton } from '@mui/material';
import { alpha } from '@mui/material/styles';

// The onboarding prompt a user pastes into Claude Code on first use — fills context.md from
// the real codebase, seeds starter tickets, and re-renders. Kept in one place so the welcome
// modal, the Help page, and the docs all speak with one voice.
export const ONBOARDING_PROMPT = `Onboard AI Maestro into this project.

1. Fill in maestro/context.md — the brief every agent reads: what this
   project is, its stack, conventions, and how to run and test it, drawn
   from the ACTUAL codebase (README, manifests, configs) — not guesses.
2. Seed maestro/board/data.json with a few real starter tickets from
   obvious near-term work (TODOs, missing tests, rough edges), status "todo".
3. Run \`npm run sync\` from the maestro/ folder so .claude/ reflects it.
4. Report back the areas, the agent roster, and whether I should commit maestro/.

Do NOT execute tickets yet. Stop after sync so I can review — then I'll
ask the orchestrator agent to start.`;

type Step = { n: number; title: string; body: React.ReactNode };
type Cmd = { cmd: string; what: string };

// The three-step golden path from "setup done" to "agents working".
const STEPS: Step[] = [
  {
    n: 1,
    title: 'Open this repo in Claude Code',
    body: <>From your project root, launch the CLI: <Code>claude</Code> — or open the repo in any compatible agentic tool.</>,
  },
  {
    n: 2,
    title: 'Onboard the project (paste the prompt)',
    body: <>Paste the onboarding prompt below. It fills <Code>maestro/context.md</Code> from your real code, seeds a few starter tickets, and runs <Code>npm&nbsp;run&nbsp;sync</Code>.</>,
  },
  {
    n: 3,
    title: 'Start conducting',
    body: <>Ask the <Code>orchestrator</Code> agent to begin — it picks the first unblocked ticket and runs it through plan → build → QA → merge.</>,
  },
];

// Handy commands, all run from the maestro/ folder unless noted.
const COMMANDS: Cmd[] = [
  { cmd: 'claude', what: 'Open Claude Code in your repo root' },
  { cmd: 'npm run sync', what: 'Re-render .claude/ after editing context.md or the board' },
  { cmd: 'npm run validate', what: "Check the board's integrity" },
  { cmd: 'npm run board', what: 'Open this visual board' },
];

function Code({ children }: { children: React.ReactNode }) {
  return (
    <Box component="code" sx={(t) => ({
      px: 0.7, py: 0.15, borderRadius: 1, fontSize: 12.5, fontFamily: 'monospace',
      bgcolor: alpha(t.palette.primary.main, 0.12), color: 'primary.main', whiteSpace: 'nowrap',
    })}>{children}</Box>
  );
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }).catch(() => { /* clipboard blocked — no-op */ });
  };
  return { copied, copy };
}

function CommandRow({ cmd, what }: Cmd) {
  const { copied, copy } = useCopy();
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.2, py: 0.9, px: 1.2, borderRadius: 1.5,
      '&:hover': { bgcolor: 'action.hover' } }}>
      <Box component="code" sx={(t) => ({
        flexShrink: 0, px: 1, py: 0.4, borderRadius: 1, fontSize: 12.5, fontFamily: 'monospace',
        fontWeight: 700, color: 'primary.main', bgcolor: alpha(t.palette.primary.main, 0.1),
        border: '1px solid', borderColor: alpha(t.palette.primary.main, 0.22), minWidth: 128,
      })}>{cmd}</Box>
      <Typography sx={{ flexGrow: 1, fontSize: 13, color: 'text.secondary' }}>{what}</Typography>
      <Tooltip title={copied ? 'Copied!' : 'Copy'}>
        <IconButton size="small" onClick={() => copy(cmd)} aria-label={`copy ${cmd}`}
          sx={{ fontSize: 13, width: 26, height: 26 }}>{copied ? '✓' : '⧉'}</IconButton>
      </Tooltip>
    </Box>
  );
}

// The full cheat sheet body — shared by the first-run welcome modal and the Help page.
export default function CheatSheet({ compact = false }: { compact?: boolean }) {
  const { copied, copy } = useCopy();
  return (
    <Box>
      {!compact && (
        <Typography sx={{ fontSize: 13.5, color: 'text.secondary', mb: 2.5 }}>
          AI Maestro conducts a roster of AI coding agents against your board. Here's the fast path
          from a fresh setup to agents doing real work.
        </Typography>
      )}

      {/* Three-step golden path */}
      <Box sx={{ display: 'grid', gap: 1.4, mb: 3 }}>
        {STEPS.map((s) => (
          <Box key={s.n} sx={{ display: 'flex', gap: 1.6, alignItems: 'flex-start' }}>
            <Box sx={{ flexShrink: 0, width: 26, height: 26, borderRadius: '50%', display: 'grid',
              placeItems: 'center', fontSize: 13, fontWeight: 800, color: '#fff',
              background: 'linear-gradient(135deg, #8b8cf0, #f0a5c8)' }}>{s.n}</Box>
            <Box sx={{ pt: 0.1 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 700, mb: 0.3 }}>{s.title}</Typography>
              <Typography sx={{ fontSize: 13, color: 'text.secondary', lineHeight: 1.55 }}>{s.body}</Typography>
            </Box>
          </Box>
        ))}
      </Box>

      {/* The copyable onboarding prompt */}
      <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.11em', textTransform: 'uppercase',
        color: 'text.secondary', mb: 0.8 }}>Onboarding prompt — paste into Claude Code</Typography>
      <Box sx={(t) => ({ position: 'relative', borderRadius: 2, border: '1px solid',
        borderColor: alpha(t.palette.primary.main, 0.25), bgcolor: alpha(t.palette.primary.main, 0.06), mb: 3 })}>
        <Box component="pre" sx={{ m: 0, p: 2, pr: 6, fontSize: 12, lineHeight: 1.6, fontFamily: 'monospace',
          whiteSpace: 'pre-wrap', color: 'text.primary', maxHeight: compact ? 168 : 'none', overflowY: 'auto' }}>
          {ONBOARDING_PROMPT}
        </Box>
        <Tooltip title={copied ? 'Copied!' : 'Copy prompt'}>
          <IconButton size="small" onClick={() => copy(ONBOARDING_PROMPT)} aria-label="copy onboarding prompt"
            sx={{ position: 'absolute', top: 8, right: 8 }}>{copied ? '✓' : '⧉'}</IconButton>
        </Tooltip>
      </Box>

      {/* Command reference */}
      <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: '.11em', textTransform: 'uppercase',
        color: 'text.secondary', mb: 0.4 }}>Commands</Typography>
      <Box sx={(t) => ({ borderRadius: 2, border: '1px solid', borderColor: 'divider',
        bgcolor: alpha(t.palette.text.primary, 0.02), py: 0.4, px: 0.4 })}>
        {COMMANDS.map((c) => <CommandRow key={c.cmd} {...c} />)}
      </Box>
      <Typography sx={{ fontSize: 11.5, color: 'text.disabled', mt: 1.2 }}>
        Run <Code>npm run …</Code> commands from the <Code>maestro/</Code> folder.
      </Typography>
    </Box>
  );
}
