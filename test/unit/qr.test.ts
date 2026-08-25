import { describe, expect, it } from "vitest";

import { toPng, toTerminal } from "../../src/wc/qr.js";

const URI = "wc:7f2a@2?relay-protocol=irn&symKey=deadbeef";

describe("QR rendering", () => {
  it("produces a real PNG, base64 with no data: prefix", async () => {
    const b64 = await toPng(URI);
    expect(b64.startsWith("data:")).toBe(false);
    const bytes = Buffer.from(b64, "base64");
    // PNG magic number: 89 50 4E 47 -> \x89PNG
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("renders ASCII art for the terminal", async () => {
    const art = await toTerminal(URI);
    expect(art.length).toBeGreaterThan(100);
    expect(art).toMatch(/[█▀▄ ]/);
  });

  it("encodes distinct URIs differently", async () => {
    expect(await toPng(URI)).not.toBe(await toPng(`${URI}&x=1`));
  });
});
