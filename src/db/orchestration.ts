import { Collection, ObjectId } from 'mongodb';
import { getDb } from './client.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OrchSkill {
  _id?: ObjectId;
  user_id: ObjectId;
  label: string;
  skill_id: string;
  description: string;
  // skill_category distinguishes integration connectors from behavioral instruction modules
  skill_category?: 'integration' | 'behavioral';
  // Integration fields
  prompt: string;
  provider: string;
  auth_type: string;
  skill_type: string;
  endpoint: string;
  rate_limit: string;
  tool_ids: string[];
  // Behavioral fields — prompt holds instruction content; trigger describes when to activate
  trigger?: string;
  color: string;
  notes: string;
  is_enabled: boolean;
  is_builtin?: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface OrchParamDef {
  name: string;
  type: string;
  required?: boolean;
  desc: string;
  default_val?: string;
  enum_values?: string;
}

export interface OrchTool {
  _id?: ObjectId;
  user_id: ObjectId;
  label: string;
  tool_id: string;
  fn: string;
  description: string;
  category: string;
  skill_id: string;
  color: string;
  inputs: OrchParamDef[];
  output: string;
  endpoint: string;
  auth_type: string;
  rate_limit: string;
  timeout_ms: string;
  notes: string;
  is_builtin?: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface OrchAgent {
  _id?: ObjectId;
  user_id: ObjectId;
  label: string;
  agent_id: string;
  description: string;
  system_prompt: string;
  skill_ids: string[];
  process_ids: string[];
  color: string;
  model: string;
  is_enabled: boolean;
  is_builtin?: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface OrchProcess {
  _id?: ObjectId;
  user_id: ObjectId;
  label: string;
  process_id: string;
  description: string;
  prompt: string;
  command: string;        // slash command — user types /command in chat to trigger
  agent_ids: string[];
  mode: 'sequential' | 'parallel';
  color: string;
  notes: string;
  is_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

// ── Collection accessors ──────────────────────────────────────────────────────

export async function orchSkillsCol(): Promise<Collection<OrchSkill>> {
  const db = await getDb();
  return db.collection<OrchSkill>('orch_skills');
}

export async function orchToolsCol(): Promise<Collection<OrchTool>> {
  const db = await getDb();
  return db.collection<OrchTool>('orch_tools');
}

export async function orchAgentsCol(): Promise<Collection<OrchAgent>> {
  const db = await getDb();
  return db.collection<OrchAgent>('orch_agents');
}

export async function orchProcessesCol(): Promise<Collection<OrchProcess>> {
  const db = await getDb();
  return db.collection<OrchProcess>('orch_processes');
}

// ── Indexes ───────────────────────────────────────────────────────────────────

export async function ensureOrchIndexes(): Promise<void> {
  const [skills, tools, agents, processes] = await Promise.all([
    orchSkillsCol(),
    orchToolsCol(),
    orchAgentsCol(),
    orchProcessesCol(),
  ]);

  await Promise.all([
    skills.createIndex({ user_id: 1 }),
    skills.createIndex({ user_id: 1, skill_id: 1 }, { unique: true }),
    tools.createIndex({ user_id: 1 }),
    tools.createIndex({ user_id: 1, tool_id: 1 }, { unique: true }),
    agents.createIndex({ user_id: 1 }),
    agents.createIndex({ user_id: 1, agent_id: 1 }, { unique: true }),
    processes.createIndex({ user_id: 1 }),
    processes.createIndex({ user_id: 1, process_id: 1 }, { unique: true }),
  ]);

  console.log('[Orchestration] Indexes ensured');
}
