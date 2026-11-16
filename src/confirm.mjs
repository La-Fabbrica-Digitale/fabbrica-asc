// Two-step confirmation in a native OS dialog, opened by the server process.
// The model gets only the outcome; it cannot see, click or type into the dialog.
// MCP elicitation is not used: Claude Desktop does not render it (checked Nov 2026).
import { execFile } from "node:child_process";

const OSA = `on run argv
  set {t, msg, mode, secs} to {item 1 of argv, item 2 of argv, item 3 of argv, (item 4 of argv) as integer}
  if mode is "ask" then
    set r to display dialog msg with title t buttons {"Cancel", "Continue"} default button "Cancel" cancel button "Cancel" with icon caution giving up after secs
    if gave up of r then return "TIMEOUT"
    return button returned of r
  end if
  set r to display dialog msg with title t default answer "" buttons {"Cancel", "Confirm"} default button "Confirm" cancel button "Cancel" with icon stop giving up after secs
  if gave up of r then return "TIMEOUT"
  return text returned of r
end run`;

const PS_ASK = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:FAC_MSG, $env:FAC_TITLE, 'OKCancel', 'Warning', 'Cancel')`;
const PS_TYPE = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::InputBox($env:FAC_MSG, $env:FAC_TITLE, '')`;

function run(cmd, args, timeoutSec, env) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: (timeoutSec + 5) * 1000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        resolve({ err, out: String(stdout).trim(), stderr: String(stderr) });
      },
    );
  });
}

// mode "ask": Cancel/Continue. mode "type": text field.
// Returns { cancelled: true, timeout? } or { text } ("Continue" for ask).
async function dialog(mode, title, msg, timeoutSec) {
  if (process.platform === "darwin") {
    const r = await run("osascript", ["-e", OSA, title, msg, mode, String(timeoutSec)], timeoutSec);
    if (r.err) {
      if (r.stderr.includes("-128")) return { cancelled: true }; // Cancel button
      throw new Error(`confirmation dialog failed: ${r.stderr.trim() || r.err.message}`);
    }
    return r.out === "TIMEOUT" ? { cancelled: true, timeout: true } : { text: r.out };
  }
  if (process.platform === "win32") {
    const r = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", mode === "ask" ? PS_ASK : PS_TYPE],
      timeoutSec,
      { FAC_MSG: msg, FAC_TITLE: title },
    );
    if (r.err) throw new Error(`confirmation dialog failed: ${r.stderr.trim() || r.err.message}`);
    if (mode === "ask") return r.out === "OK" ? { text: "Continue" } : { cancelled: true };
    return r.out ? { text: r.out } : { cancelled: true };
  }
  const args =
    mode === "ask"
      ? [
          "--question",
          "--no-markup",
          "--title",
          title,
          "--text",
          msg,
          "--ok-label",
          "Continue",
          "--cancel-label",
          "Cancel",
          "--default-cancel",
          "--timeout",
          String(timeoutSec),
        ]
      : ["--entry", "--no-markup", "--title", title, "--text", msg, "--timeout", String(timeoutSec)];
  const r = await run("zenity", args, timeoutSec);
  if (r.err?.code === "ENOENT") throw new Error("zenity not found; dangerous actions need a desktop session");
  if (r.err) return { cancelled: true, timeout: r.err.code === 5 };
  return { text: mode === "ask" ? "Continue" : r.out };
}

export async function doubleConfirm({ action, summary, phrase, timeoutSec = 180 }) {
  const title = `fabbrica-appstoreconnect: ${action}`;
  const step1 = await dialog(
    "ask",
    title,
    [...summary, "", "Requested by the AI assistant. Continue only if you asked for this."].join("\n"),
    timeoutSec,
  );
  if (step1.cancelled) return { confirmed: false, reason: step1.timeout ? "timeout on step 1" : "cancelled on step 1" };
  const step2 = await dialog("type", title, `Step 2 of 2. Type exactly:\n\n${phrase}`, timeoutSec);
  if (step2.cancelled) return { confirmed: false, reason: step2.timeout ? "timeout on step 2" : "cancelled on step 2" };
  if (step2.text.trim() !== phrase) return { confirmed: false, reason: "typed phrase did not match" };
  return { confirmed: true };
}
