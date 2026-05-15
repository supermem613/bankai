// LifecycleScope: a stack of cleanup callbacks, unwound in LIFO order. Used
// by environment plugins to register cleanups as resources are acquired so
// that a partial setup throw still releases everything that was created
// before the throw. Invariants the next editor must preserve:
//   1. Unwind order is strict LIFO. The last deferred cleanup runs first so
//      teardown mirrors construction order regardless of which resources had
//      a chance to register.
//   2. An individual cleanup throw does not stop later cleanups. Each error
//      is captured and reported via onCleanupError when one is supplied. The
//      plugin author should not need to wrap every cleanup in try/catch.
//   3. Unwind is idempotent. Once a deferred function has run it is removed
//      from the stack. A second unwind call is a no-op so the orchestrator
//      can call it as a belt-and-suspenders safety net after handle.teardown.

export type CleanupFn = () => void | Promise<void>;

export interface LifecycleScope {
  defer(cleanup: CleanupFn): void;
  unwind(): Promise<void>;
}

export interface CreateLifecycleScopeOptions {
  onCleanupError?: (err: unknown) => void;
}

export function createLifecycleScope(opts: CreateLifecycleScopeOptions = {}): LifecycleScope {
  const stack: CleanupFn[] = [];
  return {
    defer(cleanup: CleanupFn): void {
      stack.push(cleanup);
    },
    async unwind(): Promise<void> {
      while (stack.length > 0) {
        const cleanup = stack.pop();
        if (!cleanup) {
          continue;
        }
        try {
          await cleanup();
        } catch (err) {
          if (opts.onCleanupError) {
            opts.onCleanupError(err);
          }
        }
      }
    },
  };
}
