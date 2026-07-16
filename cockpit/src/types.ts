export interface BoardEpic {
  id: string;
  name: string;
  desc?: string;
  collapsed?: boolean;
}

// Core fields are typed; extras are tolerated so a board can carry custom keys.
export interface BoardTicket {
  id: string;
  epicId?: string;
  name: string;
  desc?: string;
  area?: string;
  priority?: string;
  swag?: string;
  status: string;
  depends_on?: string[];
  agent_plan?: string[];
  model?: string;
  execution_mode?: string;
  wave?: number;
  agent?: string;
  human_gate?: string;
  testCmd?: string;
  evidence?: string;
  [key: string]: unknown;
}

export interface Board {
  boardDir: string;
  epics: BoardEpic[];
  tickets: BoardTicket[];
  archived: BoardTicket[];
  archivedEpics: BoardEpic[];
}
