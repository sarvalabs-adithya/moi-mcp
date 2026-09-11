import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WriteJournal, type JournalEntry, type JournalState } from "../../src/journal.js";

const tempDirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moi-journal-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("WriteJournal", () => {
  describe("append", () => {
    it("appends entries to the journal", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });

      const content = readFileSync(join(dir, "journal.jsonl"), "utf8");
      expect(content).toContain("entry1");
      expect(content).toContain("proposed");
      expect(content).toContain("user1");
    });

    it("includes timestamp in entries", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const before = new Date().toISOString();

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });

      const after = new Date().toISOString();
      const content = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const entry = JSON.parse(content.trim());

      const timestamp = new Date(entry.timestamp);
      expect(timestamp.getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
      expect(timestamp.getTime()).toBeLessThanOrEqual(new Date(after).getTime());
    });

    it("stores optional fields", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        ixHash: "0xabc123",
        state: "signed" as JournalState,
        detail: "Signed by wallet",
      });

      const content = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const entry = JSON.parse(content.trim());

      expect(entry.ixHash).toBe("0xabc123");
      expect(entry.detail).toBe("Signed by wallet");
    });

    it("creates journal.jsonl in dataDir", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });

      expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);
    });

    it("appends multiple entries", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });
      await journal.append({
        id: "entry2",
        userId: "user2",
        kind: "create_asset",
        state: "broadcast" as JournalState,
      });

      const content = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("entry1");
      expect(lines[1]).toContain("entry2");
    });
  });

  describe("update", () => {
    it("appends a new line with the same id", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });

      await journal.update("entry1", "signed" as JournalState);

      const content = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("proposed");
      expect(lines[1]).toContain("signed");
      expect(lines[1]).toContain("entry1");
    });

    it("never rewrites the file", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      const journalPath = join(dir, "journal.jsonl");

      // Append initial entry
      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });

      const firstSize = readFileSync(journalPath, "utf8").length;

      // Update the entry multiple times
      await journal.update("entry1", "signed" as JournalState);
      const secondSize = readFileSync(journalPath, "utf8").length;
      expect(secondSize).toBeGreaterThan(firstSize);

      await journal.update("entry1", "broadcast" as JournalState);
      const thirdSize = readFileSync(journalPath, "utf8").length;
      expect(thirdSize).toBeGreaterThan(secondSize);

      // File was only appended to, not rewritten
      const finalContent = readFileSync(journalPath, "utf8");
      const lines = finalContent.trim().split("\n");
      expect(lines).toHaveLength(3);
    });

    it("maintains context from original entry", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        ixHash: "0xabc123",
        state: "proposed" as JournalState,
      });

      await journal.update("entry1", "signed" as JournalState);

      const content = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const lines = content.trim().split("\n");
      const updated = JSON.parse(lines[1]!);

      expect(updated.userId).toBe("user1");
      expect(updated.kind).toBe("transfer");
      expect(updated.ixHash).toBe("0xabc123");
    });

    it("supports patch data", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "broadcast" as JournalState,
      });

      await journal.update("entry1", "confirmed" as JournalState, {
        detail: "Confirmed on block 12345",
      });

      const content = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const lines = content.trim().split("\n");
      const updated = JSON.parse(lines[1]!);

      expect(updated.detail).toBe("Confirmed on block 12345");
    });
  });

  describe("pending", () => {
    it("returns entries that are not terminal", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });
      await journal.append({
        id: "entry2",
        userId: "user2",
        kind: "create_asset",
        state: "broadcast" as JournalState,
      });

      const pending = await journal.pending();
      expect(pending).toHaveLength(2);
    });

    it("excludes terminal state entries (confirmed)", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });
      await journal.update("entry1", "confirmed" as JournalState);

      const pending = await journal.pending();
      expect(pending).toHaveLength(0);
    });

    it("excludes terminal state entries (failed)", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });
      await journal.update("entry1", "failed" as JournalState);

      const pending = await journal.pending();
      expect(pending).toHaveLength(0);
    });

    it("excludes terminal state entries (orphaned)", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });
      await journal.update("entry1", "orphaned" as JournalState);

      const pending = await journal.pending();
      expect(pending).toHaveLength(0);
    });

    it("uses the last state for each id", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });
      await journal.update("entry1", "signed" as JournalState);
      await journal.update("entry1", "broadcast" as JournalState);
      await journal.update("entry1", "confirmed" as JournalState);

      const pending = await journal.pending();
      expect(pending).toHaveLength(0);
    });

    it("mixes terminal and non-terminal entries correctly", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      // Entry 1: confirmed (terminal)
      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });
      await journal.update("entry1", "confirmed" as JournalState);

      // Entry 2: broadcast (non-terminal)
      await journal.append({
        id: "entry2",
        userId: "user2",
        kind: "create_asset",
        state: "broadcast" as JournalState,
      });

      // Entry 3: proposed (non-terminal)
      await journal.append({
        id: "entry3",
        userId: "user3",
        kind: "transfer",
        state: "proposed" as JournalState,
      });

      const pending = await journal.pending();
      expect(pending).toHaveLength(2);
      const ids = pending.map((e) => e.id).sort();
      expect(ids).toEqual(["entry2", "entry3"]);
    });
  });

  describe("reconcileOnBoot", () => {
    it("calls handler for each pending entry", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "broadcast" as JournalState,
      });
      await journal.append({
        id: "entry2",
        userId: "user2",
        kind: "create_asset",
        state: "proposed" as JournalState,
      });

      const handled: string[] = [];
      const handler = vi.fn(async (entry: JournalEntry) => {
        handled.push(entry.id);
      });

      await journal.reconcileOnBoot(handler);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handled.sort()).toEqual(["entry1", "entry2"]);
    });

    it("does not call handler for terminal entries", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "confirmed" as JournalState,
      });
      await journal.append({
        id: "entry2",
        userId: "user2",
        kind: "create_asset",
        state: "broadcast" as JournalState,
      });

      const handled: string[] = [];
      const handler = vi.fn(async (entry: JournalEntry) => {
        handled.push(entry.id);
      });

      await journal.reconcileOnBoot(handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handled).toEqual(["entry2"]);
    });

    it("isolates handler errors so one failure does not stop others", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "broadcast" as JournalState,
      });
      await journal.append({
        id: "entry2",
        userId: "user2",
        kind: "create_asset",
        state: "broadcast" as JournalState,
      });
      await journal.append({
        id: "entry3",
        userId: "user3",
        kind: "transfer",
        state: "broadcast" as JournalState,
      });

      const handled: string[] = [];
      const handler = vi.fn(async (entry: JournalEntry) => {
        if (entry.id === "entry2") {
          throw new Error("Handler failed for entry2");
        }
        handled.push(entry.id);
      });

      // This should not throw
      await expect(journal.reconcileOnBoot(handler)).resolves.not.toThrow();

      expect(handler).toHaveBeenCalledTimes(3);
      expect(handled).toEqual(["entry1", "entry3"]);
    });

    it("calls handlers sequentially, not in parallel", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "broadcast" as JournalState,
      });
      await journal.append({
        id: "entry2",
        userId: "user2",
        kind: "create_asset",
        state: "broadcast" as JournalState,
      });

      const callOrder: string[] = [];
      const handler = vi.fn(async (entry: JournalEntry) => {
        callOrder.push(`start-${entry.id}`);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push(`end-${entry.id}`);
      });

      await journal.reconcileOnBoot(handler);

      // Should interleave start/end, not do all starts then all ends
      expect(callOrder[0]).toMatch(/^start-/);
      expect(callOrder[1]).toMatch(/^end-/);
      expect(callOrder[2]).toMatch(/^start-/);
      expect(callOrder[3]).toMatch(/^end-/);
    });
  });

  describe("truncated line tolerance", () => {
    it("tolerates truncated final line", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      // Write two complete entries
      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });
      await journal.append({
        id: "entry2",
        userId: "user2",
        kind: "create_asset",
        state: "broadcast" as JournalState,
      });

      // Manually truncate the final line (simulate crash mid-append)
      const journalPath = join(dir, "journal.jsonl");
      const content = readFileSync(journalPath, "utf8");
      const lines = content.split("\n");
      const truncated = lines.slice(0, -2).join("\n") + "\n" + lines[lines.length - 2]!.slice(0, 20);
      require("node:fs").writeFileSync(journalPath, truncated);

      // pending() should still return the first entry
      const pending = await journal.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe("entry1");
    });

    it("skips invalid JSON in middle of file", async () => {
      const dir = tempDataDir();
      const journalPath = join(dir, "journal.jsonl");

      const entry1 = JSON.stringify({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed",
        timestamp: new Date().toISOString(),
      });

      const badLine = "{not valid json";

      const entry2 = JSON.stringify({
        id: "entry2",
        userId: "user2",
        kind: "create_asset",
        state: "broadcast",
        timestamp: new Date().toISOString(),
      });

      const content = `${entry1}\n${badLine}\n${entry2}\n`;
      require("node:fs").mkdirSync(dir, { recursive: true });
      require("node:fs").writeFileSync(journalPath, content);

      const journal = new WriteJournal(dir);
      const pending = await journal.pending();

      // Should have entry1 and entry2, skip the bad line
      expect(pending).toHaveLength(2);
      expect(pending.map((e) => e.id).sort()).toEqual(["entry1", "entry2"]);
    });
  });

  describe("empty and missing journal", () => {
    it("handles missing journal file gracefully", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      const pending = await journal.pending();
      expect(pending).toEqual([]);
    });

    it("handles empty journal file", async () => {
      const dir = tempDataDir();
      const journalPath = join(dir, "journal.jsonl");
      require("node:fs").mkdirSync(dir, { recursive: true });
      require("node:fs").writeFileSync(journalPath, "");

      const journal = new WriteJournal(dir);
      const pending = await journal.pending();
      expect(pending).toEqual([]);
    });

    it("handles journal with only empty lines", async () => {
      const dir = tempDataDir();
      const journalPath = join(dir, "journal.jsonl");
      require("node:fs").mkdirSync(dir, { recursive: true });
      require("node:fs").writeFileSync(journalPath, "\n\n\n");

      const journal = new WriteJournal(dir);
      const pending = await journal.pending();
      expect(pending).toEqual([]);
    });
  });

  describe("replay ordering", () => {
    it("takes the last state per id when replaying", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      // Create entry with multiple state transitions
      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });
      await journal.update("entry1", "signed" as JournalState);
      await journal.update("entry1", "broadcast" as JournalState);

      const pending = await journal.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.state).toBe("broadcast");
    });

    it("handles multiple ids with different state transitions", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);

      // Entry 1: proposed -> signed
      await journal.append({
        id: "entry1",
        userId: "user1",
        kind: "transfer",
        state: "proposed" as JournalState,
      });
      await journal.update("entry1", "signed" as JournalState);

      // Entry 2: broadcast
      await journal.append({
        id: "entry2",
        userId: "user2",
        kind: "create_asset",
        state: "broadcast" as JournalState,
      });

      // Entry 1: confirmed (terminal)
      await journal.update("entry1", "confirmed" as JournalState);

      const pending = await journal.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe("entry2");
    });
  });
});
