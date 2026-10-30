import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { CdpSession, type CdpEvent } from "./cdp.ts";

function session(write: (data: string) => Promise<void> = async () => {}) {
  const sent: any[] = [];
  const events: CdpEvent[] = [];
  const cdp = new CdpSession(
    {
      write: (data) => {
        sent.push(JSON.parse(data));
        return write(data);
      },
    },
    (event) => events.push(event),
  );
  return { cdp, sent, events };
}

test("a command resolves with the reply that carries its id", async () => {
  const { cdp, sent } = session();
  const first = cdp.send("Page.getNavigationHistory");
  const second = cdp.send("Page.reload", { ignoreCache: true });
  assert.deepEqual(sent[1], { id: 2, method: "Page.reload", params: { ignoreCache: true } });
  cdp.receive(JSON.stringify({ id: 2, result: {} }));
  cdp.receive(JSON.stringify({ id: 1, result: { currentIndex: 0, entries: [] } }));
  assert.deepEqual(await first, { currentIndex: 0, entries: [] });
  assert.deepEqual(await second, {});
});

test("an error reply, a failed write and a closed session resolve with null", async () => {
  const failing = session(async () => {
    throw new Error("closed");
  });
  assert.equal(await failing.cdp.send("Page.enable"), null);

  const { cdp } = session();
  const errored = cdp.send("Page.navigate");
  cdp.receive(JSON.stringify({ id: 1, error: { message: "bad" } }));
  assert.equal(await errored, null);

  const unanswered = cdp.send("Page.enable");
  cdp.close();
  assert.equal(await unanswered, null);
});

test("messages without an id are page events", () => {
  const { cdp, events } = session();
  cdp.receive(JSON.stringify({ method: "Page.frameStoppedLoading", params: { frameId: "f" } }));
  assert.deepEqual(events, [{ method: "Page.frameStoppedLoading", params: { frameId: "f" } }]);
});
