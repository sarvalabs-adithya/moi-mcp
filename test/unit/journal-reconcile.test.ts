/**
 * What boot reconciliation must never do: call a transaction that reached
 * the chain "orphaned". A journal entry at "broadcast" carrying a hash is a
 * receipt, not a loss.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WriteJournal } from "../../src/journal.js";
import { reconcileJournalOnBoot } from "../../src/server.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function journal(): WriteJournal {
  const dir = mkdtempSync(join(tmpdir(), "moi-journal-"));
  dirs.push(dir);
  return new WriteJournal(dir);
}

async function stateOf(j: WriteJournal, id: string): Promise<{ state: string; ixHash?: string } | undefined> {
  const all = await j.current();
  return all.find((e) => e.id === id) as { state: string; ixHash?: string } | undefined;
}

describe("boot reconciliation", () => {
  it("finalizes a write that broadcast before the process died, keeping its hash", async () => {
    const j = journal();
    await j.append({ id: "w1", userId: "u", kind: "create_asset", state: "proposed" });
    await j.update("w1", "signed");
    await j.update("w1", "broadcast", { ixHash: "0xabc" });

    await reconcileJournalOnBoot(j);

    const after = await stateOf(j, "w1");
    expect(after?.state).toBe("confirmed");
    expect(after?.ixHash).toBe("0xabc");
  });

  it("still orphans a write that never reached the chain", async () => {
    const j = journal();
    await j.append({ id: "w2", userId: "u", kind: "transfer", state: "proposed" });
    await j.update("w2", "signed");

    await reconcileJournalOnBoot(j);

    expect((await stateOf(j, "w2"))?.state).toBe("orphaned");
  });

  it("leaves nothing pending behind, so the next boot has nothing to re-report", async () => {
    const j = journal();
    await j.append({ id: "w3", userId: "u", kind: "mint", state: "proposed" });
    await j.update("w3", "broadcast", { ixHash: "0xdef" });
    await j.append({ id: "w4", userId: "u", kind: "mint", state: "proposed" });

    await reconcileJournalOnBoot(j);

    expect(await j.pending()).toEqual([]);
  });
});
