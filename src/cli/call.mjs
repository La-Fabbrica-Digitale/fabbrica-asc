// Run tools from the terminal, in-process, with the same config as the MCP server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.mjs";
import { cliEnv } from "./common.mjs";

export async function call(cmd, rest) {
  const { server } = await buildServer(cliEnv());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "fabbrica-appstoreconnect-cli", version: "1" });
  await client.connect(b);
  try {
    if (cmd === "tools") {
      const { tools } = await client.listTools();
      for (const t of tools) console.log(`${t.name.padEnd(26)} ${t.description.split(". ")[0]}`);
      return;
    }
    const [tool, json = "{}"] = rest;
    if (!tool) throw new Error("usage: call <tool> '<json args>'");
    const r = await client.callTool({ name: tool, arguments: JSON.parse(json) }, undefined, { timeout: 900000 });
    for (const c of /** @type {any[]} */ (r.content ?? [])) console.log(c.text ?? JSON.stringify(c));
    if (r.isError) process.exitCode = 1;
  } finally {
    await client.close();
  }
}
