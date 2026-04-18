// Feature-detected shutdown hooks.
//
// We deliberately only attach to hooks that don't change the runtime's
// default behavior:
//
//   Node:     process.beforeExit — fires once the event loop is otherwise
//             empty; Node waits for awaited work inside the handler, so this
//             is the ideal place to drain. We do NOT attach to SIGTERM /
//             SIGINT: users often install their own signal handlers (HTTP
//             server shutdown, database close) and our silent listener would
//             race with theirs or keep the process alive past what Ctrl+C
//             should do. For signal coverage, callers should invoke
//             `await logger.shutdown({ timeoutMs: 2000 })` from their own
//             signal handler — see README.
//
//   Browser:  visibilitychange (hidden) + pagehide — the modern guidance
//             (pagehide fires where beforeunload doesn't on mobile/Safari).
//             Best-effort only; if the browser is terminating the tab, there
//             may be no time to finish the flush.
//
//   Edge/Workers: no hooks. The runtime freezes between invocations so any
//             timer is paused. Callers MUST `await logger.flush()` in each
//             request handler before returning.
//
// Returns a disposer that removes any listeners it attached. All branches
// feature-detect to no-ops in environments where they don't apply.

export type ShutdownDisposer = () => void;

export function registerShutdown(onShutdown: () => Promise<void> | void): ShutdownDisposer {
  const disposers: ShutdownDisposer[] = [];

  const safeRun = () => {
    // Node's beforeExit will actually await this if nothing else is on the
    // event loop; browser lifecycle events do not. Errors are swallowed —
    // the logger already routes transport failures through onError.
    Promise.resolve(onShutdown()).catch(() => undefined);
  };

  // Node process lifecycle — beforeExit only, see header comment.
  const proc = (globalThis as { process?: NodeLikeProcess }).process;
  if (proc && typeof proc.once === "function") {
    const beforeExit = () => safeRun();
    proc.once("beforeExit", beforeExit);
    disposers.push(() => {
      proc.off?.("beforeExit", beforeExit);
    });
  }

  // Browser / document lifecycle — best-effort, fires when the tab hides.
  const doc = (globalThis as { document?: Document }).document;
  if (doc && typeof doc.addEventListener === "function") {
    const visibility = () => {
      if (doc.visibilityState === "hidden") safeRun();
    };
    const pageHide = () => safeRun();
    doc.addEventListener("visibilitychange", visibility);
    doc.addEventListener("pagehide", pageHide);
    disposers.push(() => {
      doc.removeEventListener("visibilitychange", visibility);
      doc.removeEventListener("pagehide", pageHide);
    });
  }

  return () => {
    for (const d of disposers) d();
  };
}

// Minimal shape we need from `process`, typed locally so this module doesn't
// force a Node types dependency on consumers running in edge/browser.
interface NodeLikeProcess {
  once: (event: string, handler: () => void) => void;
  off?: (event: string, handler: () => void) => void;
}
