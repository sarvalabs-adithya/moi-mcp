import { describe, expect, it } from "vitest";

import { projectIdIssue, projectIdIsUnusable, WC_PROJECT_ID_HELP } from "../../src/config.js";

const REAL = "2f5a8c1de94b47f0a3c6e8b90d1a7c42"; // 32 hex, shape of a Reown id

describe("projectIdIssue", () => {
  it("accepts a well-formed id", () => {
    expect(projectIdIssue(REAL)).toBeUndefined();
    expect(projectIdIsUnusable(REAL)).toBe(false);
  });

  it("names the variable and cloud.reown.com when unset", () => {
    const issue = projectIdIssue(undefined)!;
    expect(issue).toContain("WC_PROJECT_ID");
    expect(issue).toContain("cloud.reown.com");
    expect(projectIdIsUnusable(undefined)).toBe(true);
  });

  it("catches the placeholders people actually leave behind", () => {
    for (const v of ["REPLACE_ME", "replace_with_your_project_id", "<your-id>", "{id}", "TODO", "  "]) {
      expect(projectIdIssue(v), v).toBeDefined();
      expect(projectIdIsUnusable(v), v).toBe(true);
    }
  });

  it("warns about a wrong-shaped id but does not call it unusable", () => {
    // The format is Reown's to change; refusing a valid id would be worse.
    const issue = projectIdIssue("abc123")!;
    expect(issue).toMatch(/32 hex characters/);
    expect(issue).toContain("cloud.reown.com");
    expect(projectIdIsUnusable("abc123")).toBe(false);
  });

  it("every complaint tells you where to go", () => {
    for (const v of [undefined, "", "REPLACE_ME", "abc123"]) {
      expect(projectIdIssue(v)).toContain("cloud.reown.com");
    }
    expect(WC_PROJECT_ID_HELP).toContain("WC_PROJECT_ID");
  });
});
