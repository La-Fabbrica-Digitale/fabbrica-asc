#!/usr/bin/env node
// fabbrica-appstoreconnect            → MCP server on stdio (what MCP clients run)
// fabbrica-appstoreconnect init       → setup wizard: key, folders, groups, client config
// fabbrica-appstoreconnect doctor     → check key, network, and enabled groups
// fabbrica-appstoreconnect tools      → list tools enabled with the current config
// fabbrica-appstoreconnect call <tool> '<json>'  → call one tool from the terminal
// fabbrica-appstoreconnect test-dialog → show the two confirmation dialogs (type TEST 123)
const [cmd, ...rest] = process.argv.slice(2);

const run = async () => {
  switch (cmd) {
    case undefined:
    case "serve":
      return (await import("../src/server.mjs")).startServer();
    case "init":
      return (await import("../src/cli/init.mjs")).init(rest);
    case "doctor":
      return (await import("../src/cli/doctor.mjs")).doctor(rest);
    case "tools":
    case "call":
      return (await import("../src/cli/call.mjs")).call(cmd, rest);
    case "test-dialog": {
      const { doubleConfirm } = await import("../src/confirm.mjs");
      const r = await doubleConfirm({
        action: "dialog test",
        summary: ["This is a test. Nothing is sent to Apple."],
        phrase: "TEST 123",
        timeoutSec: 120,
      });
      console.log(r.confirmed ? "confirmed: dialogs work" : `not confirmed: ${r.reason}`);
      return;
    }
    case "-v":
    case "--version": {
      const { VERSION } = await import("../src/server.mjs");
      console.log(VERSION);
      return;
    }
    default:
      console.log(
        "Usage: fabbrica-appstoreconnect [serve|init|doctor|tools|call <tool> '<json>'|test-dialog|--version]",
      );
      process.exitCode = cmd === "-h" || cmd === "--help" ? 0 : 1;
  }
};
run().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
