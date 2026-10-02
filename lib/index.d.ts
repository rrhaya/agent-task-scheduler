export type TaskStatus = 'pending' | 'running' | 'quota_blocked' | 'review' | 'done' | 'failed' | 'needs_attention' | 'auth_error' | 'interrupted';
export interface Task {
  id: string; title?: string; prompt: string; cwd: string; priority?: number;
  agent?: string; dependsOn?: string[]; isolation?: 'worktree' | 'directory';
  estimatedMinutes?: number; estimatePercent?: Record<string, number>; fingerprint?: string; warmup?: boolean; initialStatus?: 'pending' | 'done';
}
export interface QuotaWindow { id: string; usedPercent: number; durationMins: number; resetsAt: number | null; reservePercent?: number }
export interface QuotaSnapshot { known: boolean; observedAt: number; windows: QuotaWindow[]; reason?: string }
export interface QuotaReader { read(): Promise<QuotaSnapshot> }
export interface TaskSource { list(): Promise<Task[]> }
export interface RunResult { status: Exclude<TaskStatus, 'pending' | 'running' | 'done'>; sessionId?: string; output?: string; error?: string; usage?: unknown }
export interface RunContext { cwd: string; sessionId?: string; signal?: AbortSignal; onSession?: (id: string) => void; logFile?: string }
export interface AgentAdapter { quotaPool?: string; readQuota(): Promise<QuotaSnapshot>; run(task: Task, context: RunContext): Promise<RunResult> }
export interface TaskRecord extends Partial<RunResult> { status: TaskStatus; attempts: number; fingerprint: string; agent?: string; workspace?: string; branch?: string; retryAt?: number; reason?: string; logFile?: string; startedAt?: number; endedAt?: number }
export interface SchedulerState { version: 1; tasks: Record<string, TaskRecord>; warmups: Record<string, unknown> }
export interface StateStore { directory: string; read(): Promise<SchedulerState>; write(state: SchedulerState): Promise<void>; lock(): Promise<() => Promise<void>> }
export interface PolicyOptions { reservePercent?: number; weeklyReservePercent?: number; defaultEstimatePercent?: number; weeklyEstimatePercent?: number; maxSnapshotAgeMs?: number; resetBufferMs?: number; allowUnlimited?: boolean; safetyFactor?: number; fitBeforeReset?: boolean }
export class QuotaPolicy {
  constructor(options?: PolicyOptions);
  estimate(task: Task, window: QuotaWindow): number;
  evaluate(task: Task, snapshot?: QuotaSnapshot, reservations?: Task[], now?: number): { allowed: boolean; reason: string; headroom?: number };
}
export class FileStateStore implements StateStore { constructor(directory: string); directory: string; read(): Promise<SchedulerState>; write(state: SchedulerState): Promise<void>; lock(): Promise<() => Promise<void>> }
export class JsonTaskSource implements TaskSource { constructor(file: string); list(): Promise<Task[]> }
export class MarkdownDirectorySource implements TaskSource { constructor(directory: string); list(): Promise<Task[]> }
export class CombinedTaskSource implements TaskSource { constructor(sources: TaskSource[]); list(): Promise<Task[]> }
export function validateTasks(tasks: Task[], baseDir: string): Task[];
export class FileQuotaReader implements QuotaReader { constructor(file: string); read(): Promise<QuotaSnapshot> }
export class CommandQuotaReader implements QuotaReader { constructor(argv: string[], provider?: string); read(): Promise<QuotaSnapshot> }
export class CodexQuotaReader implements QuotaReader { constructor(options?: { command?: string; env?: Record<string, string>; timeoutMs?: number }); read(): Promise<QuotaSnapshot> }
export class UnknownQuotaReader implements QuotaReader { read(): Promise<QuotaSnapshot> }
export function normalizeQuota(value: unknown, now?: number): QuotaSnapshot;
export function normalizeCodexQuota(value: unknown, now?: number): QuotaSnapshot;
export interface AgentOptions { command?: string; model?: string; quotaPool?: string; env?: Record<string, string>; timeoutMs?: number; quotaReader?: QuotaReader }
export class CodexAdapter implements AgentAdapter { constructor(options?: AgentOptions & { sandbox?: 'read-only' | 'workspace-write' }); quotaPool: string; readQuota(): Promise<QuotaSnapshot>; buildArgs(task: Task, sessionId?: string): string[]; run(task: Task, context: RunContext): Promise<RunResult> }
export class ClaudeCodeAdapter implements AgentAdapter { constructor(options?: AgentOptions & { allowedTools?: string[] }); quotaPool: string; readQuota(): Promise<QuotaSnapshot>; buildArgs(task: Task, sessionId?: string): string[]; run(task: Task, context: RunContext): Promise<RunResult> }
export interface SchedulerOptions {
  source: TaskSource; store: StateStore; agents: Record<string, AgentAdapter>; policy?: QuotaPolicy;
  maxParallel?: number; pollIntervalMs?: number; maxAttempts?: number; settleMs?: number;
  warmup?: { at: string[]; timeZone?: string; agents?: string[] };
  onEvent?: (event: { type: string; at: number; [key: string]: unknown }) => void;
}
export class Scheduler { constructor(options: SchedulerOptions); store: StateStore; agents: Record<string, AgentAdapter>; plan(): Promise<{ id: string; allowed: boolean; reason: string; agent?: string }[]>; run(options?: { watch?: boolean; signal?: AbortSignal }): Promise<SchedulerState> }
export class GitWorktreeManager { constructor(stateDirectory: string); prepare(task: Task, record?: Partial<TaskRecord>): Promise<{ workspace: string; branch?: string }> }
export function schedulerFromConfig(file?: string, options?: Pick<SchedulerOptions, 'onEvent'> & { envFile?: string; env?: Record<string, string | undefined> }): Promise<Scheduler>;

export class GitHubIssuesSource implements TaskSource { constructor(options: { repository: string; cwd: string; labels?: string[]; agent?: string; command?: string; maxIssues?: number; baseDir?: string }); list(): Promise<Task[]> }

export function parseEnvFile(text: string): Record<string, string>;
export function loadEnvironment(options?: { envFile?: string; env?: Record<string, string | undefined> }): Promise<Record<string, string | undefined>>;
export function expandConfigEnvironment<T>(value: T, env: Record<string, string | undefined>): T;
