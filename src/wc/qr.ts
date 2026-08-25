/** WalletConnect pairing URI -> scannable QR. No MCP imports. */

import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";

/** Base64 PNG (no data: prefix) for embedding in an MCP image content block. */
export async function toPng(uri: string): Promise<string> {
  const dataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 512, errorCorrectionLevel: "M" });
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

/** ASCII QR for the terminal (`moi-mcp pair`). */
export function toTerminal(uri: string, small = true): Promise<string> {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(uri, { small }, (art: string) => resolve(art));
  });
}
