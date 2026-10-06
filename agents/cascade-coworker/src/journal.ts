/**
 * Durable per-Task state: one JSON file per Task, written atomically (temp file then rename) with
 * mode 0600 before and after every external write, so a crash leaves a `*-pending` stage to
 * inspect instead of a silent retry. A single-executor lock keeps one worker per Coworker.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { TaskState } from "./worker.js";

const TASK_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface Journal {
  load(taskId: string): TaskState | null;
  save(state: TaskState): void;
  all(): TaskState[];
}

export function fileJournal(dir: string): Journal {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = (taskId: string) => {
    if (!TASK_ID.test(taskId)) throw new Error("invalid Task id");
    return join(dir, `task-${taskId}.json`);
  };
  const load = (taskId: string): TaskState | null => (existsSync(path(taskId)) ? (JSON.parse(readFileSync(path(taskId), "utf8")) as TaskState) : null);
  return {
    load,
    save(state) {
      const target = path(state.taskId);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, target);
    },
    all() {
      return readdirSync(dir)
        .filter((f) => f.startsWith("task-") && f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as TaskState);
    },
  };
}

export function memoryJournal(): Journal {
  const states = new Map<string, TaskState>();
  return {
    load: (taskId) => structuredClone(states.get(taskId) ?? null),
    save: (state) => void states.set(state.taskId, structuredClone(state)),
    all: () => [...states.values()].map((s) => structuredClone(s)),
  };
}

/** Exclusive lock file holding this pid; a lock left by a dead process is taken over. */
export function acquireLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "worker.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(file, "utf8"));
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) throw new Error(`another Coworker worker (pid ${pid}) holds ${file}`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`could not take ${file}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
