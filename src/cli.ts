#!/usr/bin/env node
/**
 * `moi-mcp` terminal companion — pair a wallet without going through an agent.
 *
 * Unlike src/index.ts this is a normal CLI, so stdout is fine here.
 */

import { getConfig } from "./config.js";
import { messageOf } from "./errors.js";
import { NETWORKS } from "./moi/provider.js";
import { WalletConnectClient } from "./wc/client.js";
import { checkValidity, clearSession, loadSession } from "./wc/session.js";
import { toTerminal } from "./wc/qr.js";

const USAGE = `moi-mcp — MOI Wallet pairing for the MOI MCP server

Usage:
  moi-mcp pair        Show a QR code, scan it with MOI Wallet, save the session
  moi-mcp status      Show the current wallet session
  moi-mcp disconnect  End the session and delete the local session file
  moi-mcp config      Print the resolved configuration
  moi-mcp help        Show this message

The MCP server itself is started by your MCP client, not by this command.
See examples/claude-desktop.json.
`;

function clientFor() {
  const cfg = getConfig();
  return new WalletConnectClient({
    projectId: cfg.WC_PROJECT_ID,
    home: cfg.home,
    network: cfg.MOI_NETWORK,
    requestTimeoutMs: cfg.REQUEST_TIMEOUT_MS,
  });
}

async function pair(): Promise<number> {
  const cfg = getConfig();
  const info = NETWORKS[cfg.MOI_NETWORK];
  const wc = clientFor();

  const existing = await wc.currentSession();
  if (checkValidity(existing, cfg.MOI_NETWORK).valid && existing) {
    process.stdout.write(`Already paired with ${existing.account} on ${existing.network}.\n`);
    return 0;
  }

  if (!info.caip2Verified) {
    process.stdout.write(
      `Warning: ${cfg.MOI_NETWORK} has no published CAIP-2 chain id. Pairing will likely fail.\n\n`,
    );
  }

  process.stdout.write(`Pairing on ${info.label} (${info.caip2})…\n\n`);
  const { uri, approval } = await wc.pair();
  process.stdout.write(`${await toTerminal(uri)}\n`);
  process.stdout.write(`Scan with MOI Wallet, or paste this URI:\n${uri}\n\nWaiting…\n`);

  try {
    const session = await approval;
    process.stdout.write(`\nPaired: ${session.account} on ${session.network}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`\nPairing failed: ${messageOf(err)}\n`);
    return 1;
  }
}

async function status(): Promise<number> {
  const cfg = getConfig();
  const session = (await clientFor().currentSession()) ?? loadSession(cfg.home);
  if (!session) {
    process.stdout.write("No wallet paired. Run `moi-mcp pair`.\n");
    return 1;
  }
  const validity = checkValidity(session, cfg.MOI_NETWORK);
  process.stdout.write(
    JSON.stringify(
      {
        connected: validity.valid,
        ...(validity.message ? { problem: validity.message } : {}),
        account: session.account,
        network: session.network,
        chainId: session.chainId,
        peer: session.peer.name,
        expiresAt: new Date(session.expiry * 1000).toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  return validity.valid ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? "help";

  try {
    switch (command) {
      case "pair":
        return await pair();

      case "status":
        return await status();

      case "disconnect": {
        const had = await clientFor().disconnect("Disconnected from the CLI");
        process.stdout.write(had ? "Disconnected.\n" : "No wallet was paired.\n");
        return 0;
      }

      case "config": {
        const cfg = getConfig();
        process.stdout.write(
          `${JSON.stringify({ ...cfg, WC_PROJECT_ID: cfg.WC_PROJECT_ID ? "(set)" : "(unset)" }, null, 2)}\n`,
        );
        return 0;
      }

      case "clear-session": {
        clearSession(getConfig().home);
        process.stdout.write("Local session file removed.\n");
        return 0;
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
  } catch (err) {
    process.stderr.write(`${messageOf(err)}\n`);
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
