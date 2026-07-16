import { useEffect, useState } from 'react';
import type { ProjectConfig } from './types';
import { getConfig } from './api';

// Loads the project's config.json (areas, agent_plan steps, models) to drive the editors.
// Null when the board has no config.json — the UI falls back to sensible defaults.
export function useConfig() {
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  useEffect(() => { getConfig().then(setConfig).catch(() => setConfig(null)); }, []);
  return config;
}
