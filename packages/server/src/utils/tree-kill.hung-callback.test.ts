import { describe, expect, test, vi } from "vitest";
import { terminateWithTreeKill, type TreeKillTarget } from "./tree-kill.js";

// On some Windows hosts `taskkill /T` blocks for about a minute before tree-kill's
// callback fires (getpaseo/paseo#6233). No real process reproduces that on demand,
// so tree-kill is replaced with one whose callback never fires.
vi.mock("tree-kill", () => ({ default: () => undefined }));

interface FakeChild extends TreeKillTarget {
  exit(): void;
  signals: Array<NodeJS.Signals | number | undefined>;
}

function createFakeChild(): FakeChild {
  const listeners: Array<() => void> = [];
  const child: FakeChild = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    signals: [],
    kill(signal) {
      child.signals.push(signal);
      return true;
    },
    once(_event, listener) {
      listeners.push(listener);
    },
    exit() {
      child.exitCode = 0;
      for (const listener of listeners.splice(0)) listener();
    },
  };
  return child;
}

describe("terminateWithTreeKill when the tree-kill callback never fires", () => {
  test("reports a child that exits during the graceful window as terminated", async () => {
    const child = createFakeChild();
    setTimeout(() => child.exit(), 50);

    const result = await terminateWithTreeKill(child, {
      gracefulTimeoutMs: 2_000,
      forceTimeoutMs: 1_000,
    });

    expect(result).toBe("terminated");
  });

  test("reports kill-timeout once the force window passes", async () => {
    const child = createFakeChild();

    const result = await terminateWithTreeKill(child, {
      gracefulTimeoutMs: 50,
      forceTimeoutMs: 50,
    });

    expect(result).toBe("kill-timeout");
  });
});
