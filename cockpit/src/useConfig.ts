import { useEffect, useState } from 'react';
import type { ProjectConfig } from './types';
import { getConfig } from './api';

// Loads the project's config.json (areas, agent_plan steps, models) to drive the editors.
// Null when the board has no config.json — the UI falls back to sensible defaults.
// `scopeKey` refetches when the App switches portfolio scope; components that never
// switch scope can omit it.
export function useConfig(scopeKey?: string) {
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  useEffect(() => { getConfig().then(setConfig).catch(() => setConfig(null)); }, [scopeKey]);
  return config;
}
