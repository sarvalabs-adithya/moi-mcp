/**
 * Write journal for tracking interaction states through their lifecycle.
 *
 * Append-only JSONL format stored at <dataDir>/journal.jsonl.
 * Each entry has an id; update() appends a new line with the same id (never rewrites).
 * pending() returns entries whose last state is not terminal (confirmed/failed/orphaned).
 * reconcileOnBoot() runs handlers for pending entries sequentially, isolating errors.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { log } from "./config.js";
import { z } from "zod";

export type JournalState = "proposed" | "signed" | "broadcast" | "confirmed" | "failed" | "orphaned";

const TERMINAL_STATES = new Set<JournalState>(["confirmed", "failed", "orphaned"]);

/**
 * A single journal entry, including full audit trail metadata.
 */
export const JournalEntry = z.object({
  id: z.string(),
  userId: z.string(),
  kind: z.string(),
  ixHash: z.string().optional(),
  state: z.string() as z.ZodType<JournalState>,
  detail: z.string().optional(),
  timestamp: z.string(), // ISO string
});
export type JournalEntry = z.infer<typeof JournalEntry>;

/**
 * Append-only write journal for interaction lifecycle tracking.
 */
export class WriteJournal {
  private journalPath: string;

  constructor(dataDir: string) {
    this.journalPath = join(dataDir, "journal.jsonl");
    // Ensure directory exists
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 });
  }

  /**
   * Append a new entry to the journal.
   */
  async append(entry: {
    id: string;
    userId: string;
    kind: string;
    ixHash?: string;
    state: JournalState;
    detail?: string;
  }): Promise<void> {
    const record: JournalEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    const line = JSON.stringify(record);
    appendFileSync(this.journalPath, `${line}\n`, { mode: 0o600 });
  }

  /**
   * Update an entry's state by appending a new line with the same id.
   * Never rewrites the file — appends only, maintaining full audit trail.
   */
  async update(id: string, state: JournalState, patch?: Record<string, unknown>): Promise<void> {
    // Read the last entry with this id to get context
    const lastEntry = await this.findLastEntryById(id);
    if (!lastEntry) {
      log("debug", `Updating entry ${id} that doesn't exist yet in journal`);
    }

    const update: JournalEntry = {
      id,
      userId: lastEntry?.userId ?? "unknown",
      kind: lastEntry?.kind ?? "unknown",
      ixHash: (patch?.ixHash as string | undefined) ?? lastEntry?.ixHash,
      state,
      detail: patch?.detail as string | undefined,
      timestamp: new Date().toISOString(),
    };

    const line = JSON.stringify(update);
    appendFileSync(this.journalPath, `${line}\n`, { mode: 0o600 });
  }

  /**
   * The current (last-written) entry for every id ever appended, terminal
   * states included — unlike `pending()`, which deliberately excludes them.
   * For audit/inspection (e.g. tests asserting a terminal outcome like
   * "orphaned" or "confirmed").
   */
  async current(): Promise<JournalEntry[]> {
    const entries = await this.readAll();
    const lastById = new Map<string, JournalEntry>();
    for (const entry of entries) {
      lastById.set(entry.id, entry);
    }
    return Array.from(lastById.values());
  }

  /**
   * Return all entries whose last state per id is not terminal.
   * Replays the journal taking the last state for each id.
   */
  async pending(): Promise<JournalEntry[]> {
    const entries = await this.current();
    return entries.filter((entry) => !TERMINAL_STATES.has(entry.state as JournalState));
  }

  /**
   * On boot, call handler for each pending entry sequentially.
   * Isolates handler errors so one failure doesn't stop the rest.
   */
  async reconcileOnBoot(handler: (entry: JournalEntry) => Promise<void>): Promise<void> {
    const pendingEntries = await this.pending();

    for (const entry of pendingEntries) {
      try {
        await handler(entry);
      } catch (err) {
        log("error", `Failed to reconcile entry ${entry.id}: ${String(err)}`);
        // Continue to next entry even if this one fails
      }
    }
  }

  /**
   * Read all entries from the journal, tolerating truncated final lines.
   */
  private async readAll(): Promise<JournalEntry[]> {
    if (!existsSync(this.journalPath)) return [];

    try {
      const content = readFileSync(this.journalPath, "utf8");
      const lines = content.split("\n");
      const entries: JournalEntry[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? "").trim();
        if (!line) continue; // Skip empty lines (including final newline)

        try {
          const data = JSON.parse(line);
          const parsed = JournalEntry.safeParse(data);
          if (parsed.success) {
            entries.push(parsed.data);
          } else {
            log("debug", `Skipping invalid journal entry at line ${i + 1}: ${parsed.error.message}`);
          }
        } catch (err) {
          // Check if this is the last line — likely truncated
          if (i === lines.length - 1) {
            log("debug", `Skipping truncated final line in journal`);
          } else {
            log("debug", `Skipping malformed journal line ${i + 1}: ${String(err)}`);
          }
        }
      }

      return entries;
    } catch (err) {
      log("error", `Failed to read journal: ${String(err)}`);
      return [];
    }
  }

  /**
   * Find the last entry with the given id.
   */
  private async findLastEntryById(id: string): Promise<JournalEntry | undefined> {
    const entries = await this.readAll();
    let last: JournalEntry | undefined;

    for (const entry of entries) {
      if (entry.id === id) {
        last = entry;
      }
    }

    return last;
  }
}
