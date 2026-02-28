export const TicketStatusValues = [
  "pending",
  "in_progress",
  "blocked",
  "awaiting_human_test",
  "done",
  "archived",
] as const;

export type TicketStatus = (typeof TicketStatusValues)[number];

export const WorkLogKindValues = [
  "claim",
  "analysis",
  "change",
  "command",
  "handoff",
  "blocker",
  "note",
] as const;

export type WorkLogKind = (typeof WorkLogKindValues)[number];

export interface WorkLogEntry {
  at: string;
  actor: string;
  kind: WorkLogKind;
  summary: string;
  details?: {
    touched_files?: string[];
    commands?: string[];
    links?: string[];
    notes?: string[];
  };
}

export interface TicketFrontmatter {
  id: string;
  title: string;
  status: TicketStatus;
  created_at: string;
  updated_at: string;
  area: string;
  epic?: string;
  key_files: string[];
  intent: string;
  requirements: string[];
  human_testing_steps: string[];
  constraints: string[];
  depends_on: string[];
  claimed_by: string | null;
  claimed_at: string | null;
  work_log: WorkLogEntry[];
  review_notes: string | null;
  [key: string]: unknown;
}
