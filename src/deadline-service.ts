import path from 'node:path';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { atomicJson } from './files.js';
import { AppError, CORE, type AuthStatus, type Course, type Deadline } from './shared.js';

export type DeadlineConnectionState = 'connected' | 'login_required' | 'unconfigured' | 'error';
export interface DeadlineSnapshot {
  version: 1;
  courses: Array<{ id: string; name: string; shortName?: string }>;
  deadlines: Deadline[];
  lastSuccessfulSyncAt: string | null;
  connectionState: DeadlineConnectionState;
  warnings: string[];
}
export interface DeadlineFetchResult {
  courses: Course[];
  deadlines: Deadline[];
  warnings: string[];
  observedAt: string;
}
export interface DeadlineServiceOptions {
  /** The private widgets directory, containing snapshot.json. */
  directory: string;
  fetch: () => Promise<DeadlineFetchResult>;
  authState: () => AuthStatus['state'];
  changed: () => void | Promise<void>;
  /** UI-only activity updates; does not require a WidgetKit timeline reload. */
  syncChanged?: () => void | Promise<void>;
}

const maximumSnapshotBytes = 2 * 1024 * 1024;
const timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const identifier = z.string().min(1).max(256);
const courseSchema = z.object({ id: identifier, name: z.string().max(2000), shortName: z.string().max(500).optional() });
const deadlineSchema = z.object({
  id: identifier,
  courseId: identifier,
  name: z.string().max(2000),
  kind: z.enum(['assignment_due', 'assignment_cutoff', 'quiz_close', 'calendar']),
  at: timestamp,
  timezone: z.literal('Asia/Shanghai'),
  submissionStatus: z.string().max(2000).optional(),
  url: z.string().max(4096).refine(value => {
    try { const url = new URL(value); return url.origin === CORE && !url.username && !url.password; }
    catch { return false; }
  }),
  observedAt: timestamp,
  source: z.literal('moodle'),
});
const snapshotSchema = z.object({
  version: z.literal(1),
  courses: z.array(courseSchema).max(1000),
  deadlines: z.array(deadlineSchema).max(20000),
  lastSuccessfulSyncAt: timestamp.nullable(),
  connectionState: z.enum(['connected', 'login_required', 'unconfigured', 'error']),
  warnings: z.array(z.string().max(2000)).max(1000),
});

function connectionState(authState: AuthStatus['state']): DeadlineConnectionState {
  return authState === 'authenticated' ? 'connected' : authState === 'unconfigured' ? 'unconfigured' : 'login_required';
}
function emptySnapshot(state: DeadlineConnectionState): DeadlineSnapshot {
  return { version: 1, courses: [], deadlines: [], lastSuccessfulSyncAt: null, connectionState: state, warnings: [] };
}
function validatedSnapshot(raw: unknown): DeadlineSnapshot {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > maximumSnapshotBytes)
    throw new AppError('WIDGET_SNAPSHOT_INVALID', '截止时间缓存格式无效或过大。');
  // Zod objects project only these fields; credentials and diagnostic objects never cross this boundary.
  return parsed.data;
}
async function readSnapshot(file: string): Promise<DeadlineSnapshot> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximumSnapshotBytes) throw new Error('Invalid snapshot file');
    const buffer = Buffer.alloc(maximumSnapshotBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximumSnapshotBytes) throw new Error('Snapshot too large');
    return validatedSnapshot(JSON.parse(buffer.subarray(0, length).toString('utf8')));
  } finally { await handle.close(); }
}

/** Owns the full default-range cache. WidgetKit reads an exported copy, never school credentials. */
export class DeadlineService {
  private current: DeadlineSnapshot;
  private generation = 0;
  private revision = 0;
  private writes: Promise<void> = Promise.resolve();
  private flight?: { generation: number; promise: Promise<void> };
  private disposed = false;
  private readonly file: string;

  constructor(private readonly options: DeadlineServiceOptions) {
    this.file = path.join(options.directory, 'snapshot.json');
    this.current = emptySnapshot(connectionState(options.authState()));
  }
  get snapshot(): DeadlineSnapshot { return structuredClone(this.current); }
  get syncing(): boolean { return !!this.flight && this.flight.generation === this.generation && !this.disposed; }
  captureGeneration(): number { return this.generation; }

  async load(): Promise<void> {
    const generation = this.generation, revision = this.revision;
    let snapshot = emptySnapshot(connectionState(this.options.authState()));
    try { snapshot = await readSnapshot(this.file); } catch { /* Missing and corrupt caches start empty. */ }
    snapshot.connectionState = connectionState(this.options.authState());
    await this.enqueue(async () => {
      if (this.disposed || generation !== this.generation || revision !== this.revision) return;
      await this.commit(snapshot, generation);
    });
  }

  async accept(result: { deadlines: Deadline[]; warnings: string[]; observedAt: string }, courses: Course[], generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    const snapshot = validatedSnapshot({
      version: 1, courses, deadlines: result.deadlines,
      lastSuccessfulSyncAt: result.observedAt, connectionState: 'connected', warnings: result.warnings,
    });
    snapshot.deadlines.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    await this.enqueue(async () => {
      if (this.disposed || generation !== this.generation) return;
      snapshot.connectionState = connectionState(this.options.authState());
      await this.commit(snapshot, generation);
    });
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const generation = this.generation;
    if (this.flight?.generation === generation) return this.flight.promise;
    const flight = { generation, promise: Promise.resolve() };
    this.flight = flight;
    flight.promise = this.performRefresh(generation).finally(async () => {
      if (this.flight !== flight) return;
      this.flight = undefined;
      if (!this.disposed) await this.notifySyncChanged();
    });
    void this.notifySyncChanged();
    return flight.promise;
  }
  private async performRefresh(generation: number): Promise<void> {
    const state = this.options.authState();
    if (state !== 'authenticated') {
      await this.updateConnectionState(connectionState(state), generation);
      return;
    }
    try {
      const result = await this.options.fetch();
      if (this.disposed || generation !== this.generation) return;
      // Logout or an interactive login during a fetch must not restore the connected label.
      if (this.options.authState() !== 'authenticated') {
        await this.updateConnectionState(connectionState(this.options.authState()), generation);
        return;
      }
      await this.accept(result, result.courses, generation);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      const auth = this.options.authState();
      const authenticationError = error instanceof AppError && ['AUTH_REQUIRED', 'AUTH_CONNECTING'].includes(error.code);
      await this.updateConnectionState(auth !== 'authenticated' ? connectionState(auth) : authenticationError ? 'login_required' : 'error', generation);
    }
  }

  async reset(): Promise<void> {
    if (this.disposed) return;
    const wasSyncing = this.syncing;
    const generation = ++this.generation;
    this.flight = undefined;
    // Clear memory immediately; serialize the empty write behind any write already in progress.
    this.current = emptySnapshot(connectionState(this.options.authState()));
    this.revision++;
    if (wasSyncing) void this.notifySyncChanged();
    const snapshot = structuredClone(this.current);
    await this.enqueue(async () => {
      if (this.disposed || generation !== this.generation) return;
      await this.commit(snapshot, generation);
    });
  }
  async setConnectionState(state: DeadlineConnectionState): Promise<void> {
    await this.updateConnectionState(state, this.generation);
  }
  private async updateConnectionState(state: DeadlineConnectionState, generation: number): Promise<void> {
    await this.enqueue(async () => {
      if (this.disposed || generation !== this.generation || this.current.connectionState === state) return;
      await this.commit({ ...this.current, connectionState: state }, generation);
    });
  }
  futureDeadlines(now: number = Date.now()): Deadline[] {
    return this.current.deadlines.filter(deadline => Date.parse(deadline.at) > now).map(deadline => ({ ...deadline }));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.flight = undefined;
    await this.writes;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const write = this.writes.then(operation);
    this.writes = write.catch(() => undefined);
    return write;
  }
  private async notifySyncChanged(): Promise<void> {
    try { await this.options.syncChanged?.(); } catch { /* UI activity reporting cannot fail a school refresh. */ }
  }
  private async commit(snapshot: DeadlineSnapshot, generation: number): Promise<void> {
    await atomicJson(this.file, snapshot);
    if (generation !== this.generation) return;
    this.current = snapshot;
    this.revision++;
    if (!this.disposed) await this.options.changed();
  }
}
