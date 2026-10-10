/**
 * Open a URL in the student's default browser.
 * OWNER: Developer 4.
 */
import { spawn } from "node:child_process";

/** Returns false if no browser could be launched. Never throws. */
export function openInBrowser(url: string): boolean {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return false; // only ever our own local page
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', `"${url}"`]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32",
    });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
