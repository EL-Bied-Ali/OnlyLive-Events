import { afterEach, describe, expect, it, vi } from "vitest";

const dispatchPendingEmailsMock = vi.fn();
vi.mock("@/lib/email/dispatcher", () => ({
  dispatchPendingEmails: (...args: unknown[]) => dispatchPendingEmailsMock(...args),
}));

const afterMock = vi.fn();
vi.mock("next/server", () => ({
  after: (...args: unknown[]) => afterMock(...args),
}));

describe("scheduleEagerEmailDispatch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers an after() callback that drains the outbox", async () => {
    dispatchPendingEmailsMock.mockResolvedValue({ claimed: 1, sent: 1, retried: 0, permanentlyFailed: 0, skipped: 0 });
    const { scheduleEagerEmailDispatch } = await import("@/lib/email/eagerDispatch");

    scheduleEagerEmailDispatch();

    expect(afterMock).toHaveBeenCalledTimes(1);
    const registeredCallback = afterMock.mock.calls[0]![0] as () => Promise<void> | void;
    await registeredCallback();
    expect(dispatchPendingEmailsMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when after() is called outside a real request scope", async () => {
    // This is exactly what happens whenever a route/Server Action is
    // invoked directly, as every existing webhook/route test in this suite
    // does -- proving the caller's own response is never put at risk by
    // this optimization is the entire point of this test.
    afterMock.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const { scheduleEagerEmailDispatch } = await import("@/lib/email/eagerDispatch");

    expect(() => scheduleEagerEmailDispatch()).not.toThrow();
    expect(dispatchPendingEmailsMock).not.toHaveBeenCalled();
  });

  it("never lets a rejection from the scheduled dispatch propagate", async () => {
    dispatchPendingEmailsMock.mockRejectedValue(new Error("boom"));
    const { scheduleEagerEmailDispatch } = await import("@/lib/email/eagerDispatch");

    scheduleEagerEmailDispatch();
    const registeredCallback = afterMock.mock.calls[0]![0] as () => Promise<void> | void;

    await expect(registeredCallback()).resolves.toBeUndefined();
  });
});
