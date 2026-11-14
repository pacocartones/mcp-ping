import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import getPort from "get-port";
import { afterEach, expect, it, vi } from "vitest";

const runPing = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: string[],
      options: { timeout: number },
    ) => Promise<{ stderr: string; stdout: string }>
  >(async () => ({
    stderr: "",
    stdout: "synthetic ping output",
  })),
);

// Keep the MCP server and client real; only replace the external process.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const execFile = Object.assign(
    () => {
      throw new Error("Unexpected direct execFile call");
    },
    { [Symbol.for("nodejs.util.promisify.custom")]: runPing },
  );

  return { ...actual, execFile };
});

import { createServer } from "./createServer.js";

const connections: Array<{
  client: Client;
  server: ReturnType<typeof createServer>;
}> = [];

const connect = async (server: ReturnType<typeof createServer>) => {
  const port = await getPort();

  await server.start({
    httpStream: { port },
    transportType: "httpStream",
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
  );
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
  } catch (error) {
    await server.stop();
    throw error;
  }

  connections.push({ client, server });
  return client;
};

afterEach(async () => {
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.stop();
  }
  runPing.mockReset();
  runPing.mockResolvedValue({ stderr: "", stdout: "synthetic ping output" });
});

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  if (!Array.isArray(result.content) || result.content[0].type !== "text") {
    throw new Error("Expected text content");
  }
  return result.content[0].text as string;
};

const callPing = async (client: Client, host: string) =>
  textOf(await client.callTool({ arguments: { host }, name: "ping" }));

it("passes a validated host as one literal argument with a timeout", async () => {
  const client = await connect(createServer());

  expect(await callPing(client, "example.com")).toContain("Ping results");
  expect(runPing).toHaveBeenCalledExactlyOnceWith(
    "ping",
    process.platform === "win32"
      ? ["-n", "4", "example.com"]
      : ["-c", "4", "example.com"],
    { timeout: 10_000 },
  );
});

it("removes URL brackets from an IPv6 literal before invoking ping", async () => {
  const client = await connect(createServer());

  expect(await callPing(client, "https://[::1]/")).toContain("Ping results");
  expect(runPing.mock.calls[0]?.[1].at(-1)).toBe("::1");
});

it.each(["127.0.0.1; echo marker", "-c", "host name", "https://%"])(
  "rejects invalid host %s without starting a process",
  async (host) => {
    const client = await connect(createServer());

    expect(await callPing(client, host)).toContain("Invalid host");
    expect(runPing).not.toHaveBeenCalled();
  },
);

it("reports a killed process as a timeout", async () => {
  runPing.mockRejectedValueOnce(
    Object.assign(new Error("terminated"), { killed: true }),
  );
  const client = await connect(createServer({ pingTimeoutMs: 1_500 }));

  expect(await callPing(client, "example.com")).toContain(
    "timed out after 1500ms",
  );
  expect(runPing.mock.calls[0]?.[2]).toEqual({ timeout: 1_500 });
});

it("reports a process failure without calling it a timeout", async () => {
  runPing.mockRejectedValueOnce(new Error("ping unavailable"));
  const client = await connect(createServer());

  expect(await callPing(client, "example.com")).toContain("ping unavailable");
  expect(runPing).toHaveBeenCalledOnce();
});

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
  "rejects an invalid timeout: %s",
  (pingTimeoutMs) => {
    expect(() => createServer({ pingTimeoutMs })).toThrow(/pingTimeoutMs/);
  },
);
