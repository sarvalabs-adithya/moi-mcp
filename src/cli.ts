#!/usr/bin/env node
/**
 * `moi-mcp` terminal companion.
 *
 * Phase 2 implements `pair` (terminal QR + wait for approval) and `status`
 * against wc/client.ts. Phase 0 ships the binary so package.json's `bin`
 * entry resolves to a real file.
 *
 * Unlike src/index.ts this is a normal CLI, so stdout is fine here.
 */

import { getConfig } from "./config.js";
import { messageOf } from "./errors.js";

const USAGE = `moi-mcp — MOI Wallet pairing for the MOI MCP server

Usage:
  moi-mcp pair      Show a QR code, scan it with MOI Wallet, save the session
  moi-mcp status    Show the current wallet session
  moi-mcp config    Print the resolved configuration
  moi-mcp help      Show this message

The MCP server itself is started by your MCP client, not by this command.
See examples/claude-desktop.json.
`;

const NOT_YET = (cmd: string): string =>
  `\`moi-mcp ${cmd}\` lands in Phase 2 (WalletConnect pairing).\n` +
  `Track: https://github.com/sarvalabs/moi-mcp/issues (open one once the repo exists).\n` +
  `Until then, wallet tools are unavailable and read-only moi_* tools work without pairing.`;

function main(argv: string[]): number {
  const command = argv[0] ?? "help";

  switch (command) {
    case "pair":
    case "status":
      process.stderr.write(`${NOT_YET(command)}\n`);
      return 1;

    case "config": {
      try {
        const cfg = getConfig();
        process.stdout.write(`${JSON.stringify({ ...cfg, WC_PROJECT_ID: cfg.WC_PROJECT_ID ? "(set)" : "(unset)" }, null, 2)}\n`);
        return 0;
      } catch (err) {
        process.stderr.write(`${messageOf(err)}\n`);
        return 1;
      }
    }

    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

process.exit(main(process.argv.slice(2)));
