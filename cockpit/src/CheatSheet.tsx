import { useState } from 'react';
import { Box, Typography, Tooltip, IconButton } from '@mui/material';
import { alpha } from '@mui/material/styles';

// The prompt a user pastes into Claude Code on first use. `setup` already wrote the brief from
// their answers, so this is the planning step: brief → epics + dependency-ordered tickets,
// stopping for review. Kept in one place so the welcome modal, the Help page, and the docs all
// speak with one voice.
export const ONBOARDING_PROMPT = `Plan this project in AI Maestro.

Read the brief I gave setup and propose an answer for anything I left as
"propose one", drawn from the ACTUAL codebase (README, manifests, configs)
— not guesses. Then turn the brief into a board: a few outcome-based epics
and small, dependency-ordered tickets, each with acceptance criteria I
could verify, all at status "todo".

Validate the board, then STOP and show me the epics, the tickets in
delivery order, which one is ready first, and every assumption that needs
my approval. Do NOT implement anything yet — once I've approved the plan
I'll ask the orchestrator agent to start.`;

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
    title: 'Plan the work',
    body: <>Run <Code>/project-plan</Code> (or paste the prompt below). It writes the project plan first — goal, scope, deliverables, use cases, requirements — then turns it into epics and dependency-ordered tickets, stopping for your review at each step. Fill any section later in the <b>Plan</b> tab or with <Code>/plan-update</Code>.</>,
  },
  {
    n: 3,
    title: 'Start conducting',
    body: <>Approve the plan, then run <Code>/orchestrator</Code> — it picks the first unblocked ticket and runs it through plan → build → QA → merge, one ticket per run.</>,
  },
];

// Handy commands, all run from the maestro/ folder unless noted. The slash commands run inside
// Claude Code at the repo root, not in a shell.
const COMMANDS: Cmd[] = [
  { cmd: 'claude', what: 'Open Claude Code in your repo root' },
  { cmd: '/project-plan', what: 'Write the project plan, then turn it into epics + tickets' },
  { cmd: '/plan-update', what: 'Fill in the plan section by section, and triage gaps' },
  { cmd: '/orchestrator', what: 'Build the next unblocked ticket (one per run)' },
  { cmd: 'npm run sync', what: 'Re-render .claude/ after editing context.md or the board' },
  { cmd: 'npm run validate', what: "Check the board's integrity and its scope against the plan" },
  { cmd: 'npm run plan -- status', what: 'How complete the project plan is, and what is thin' },
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
        color: 'text.secondary', mb: 0.8 }}>Planning prompt — paste into Claude Code</Typography>
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
