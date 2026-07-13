/** Registers a process with the tracker, returning a disposable that
 * unregisters it. Assigned via the class static block so it can access
 * private state without being part of the public API.
 * @internal
 */
export let registerTrackedProcess: (tracker: ProcessTracker, process: TrackedProcess) => Disposable;

/** A currently running OS process spawned on behalf of a command. */
export interface TrackedProcess {
  /** OS process id. */
  readonly pid: number;
  /** Resolved path of the executable that was launched.
   *
   * On Windows, a `.cmd`/`.bat` file is launched via `cmd.exe`, in which
   * case this is still the batch file's path while the pid belongs to the
   * `cmd.exe` process running it.
   */
  readonly path: string;
}

/** Event raised by a {@link ProcessTracker} when a process spawns or exits. */
export type ProcessTrackerEvent =
  | { kind: "spawned"; process: TrackedProcess }
  | { kind: "exited"; process: TrackedProcess };

/** Listener for {@link ProcessTracker} events. */
export type ProcessTrackerListener = (event: ProcessTrackerEvent) => void;

/**
 * Tracks the OS processes currently running that were spawned by the
 * commands it's attached to.
 *
 * Attach to a command via `CommandBuilder.prototype.processTracker`. A
 * single tracker may be attached to multiple commands.
 *
 * Only processes directly spawned by the shell are tracked — descendant
 * processes spawned by those processes are not visible here. Built-in
 * commands (ex. `echo`, `cd`) never appear since they don't spawn
 * processes.
 *
 * ```ts
 * const tracker = new ProcessTracker();
 * const child = $`npm run build`.processTracker(tracker).spawn();
 * // at any point while it runs:
 * for (const p of tracker.processes) {
 *   console.log(`${p.pid} — ${p.path}`);
 * }
 * ```
 */
export class ProcessTracker {
  #processes = new Set<TrackedProcess>();
  #listeners: ProcessTrackerListener[] = [];

  /** Snapshot of the processes that are currently running. */
  get processes(): readonly TrackedProcess[] {
    return [...this.#processes];
  }

  /** Registers a listener that's invoked when a process spawns or exits. */
  addListener(listener: ProcessTrackerListener): void {
    this.#listeners.push(listener);
  }

  /** Removes a previously registered listener. */
  removeListener(listener: ProcessTrackerListener): void {
    const index = this.#listeners.indexOf(listener);
    if (index >= 0) {
      this.#listeners.splice(index, 1);
    }
  }

  #raise(event: ProcessTrackerEvent) {
    // copy in case a listener adds/removes listeners while being invoked
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (err) {
        // a throwing listener must not corrupt tracking or alter command
        // execution, so surface it as an uncaught error instead
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  static {
    registerTrackedProcess = (tracker, process) => {
      tracker.#processes.add(process);
      tracker.#raise({ kind: "spawned", process });
      let disposed = false;
      return {
        [Symbol.dispose]() {
          if (disposed) {
            return;
          }
          disposed = true;
          tracker.#processes.delete(process);
          tracker.#raise({ kind: "exited", process });
        },
      };
    };
  }
}
