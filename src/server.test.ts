import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, rmSync } from "fs";
import getPort from "get-port";
import { tmpdir } from "os";
import { join } from "path";
import { expect, it } from "vitest";

import { createServer } from "./createServer.js";

const connect = async (server: ReturnType<typeof createServer>) => {
  const port = await getPort();

  await server.start({
    httpStream: {
      port,
    },
    transportType: "httpStream",
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
  );

  const client = new Client(
    {
      name: "test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await client.connect(transport);

  return client;
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  if (!Array.isArray(result.content)) {
    throw new Error("Result is not an array");
  }

  if (result.content[0].type !== "text") {
    throw new Error("Expected text content");
  }

  return result.content[0].text as string;
};

it("should ping a host", async () => {
  const client = await connect(createServer());

  const result = await client.callTool({
    arguments: {
      host: "127.0.0.1",
    },
    name: "ping",
  });

  expect(textOf(result)).toContain("PING 127.0.0.1");
});

it("should reject a host containing shell metacharacters without running it", async () => {
  const client = await connect(createServer());

  const sentinel = join(
    tmpdir(),
    `mcp-ping-injection-${process.pid}-${Date.now()}`,
  );

  rmSync(sentinel, { force: true });

  try {
    const result = await client.callTool({
      arguments: {
        host: `127.0.0.1; touch ${sentinel}`,
      },
      name: "ping",
    });

    expect(existsSync(sentinel)).toBe(false);
    expect(textOf(result)).toContain("Invalid host");
  } finally {
    rmSync(sentinel, { force: true });
  }
});

it("should time out instead of hanging on an unresponsive host", async () => {
  const client = await connect(createServer({ pingTimeoutMs: 1_500 }));

  const startedAt = Date.now();

  const result = await client.callTool({
    arguments: {
      // TEST-NET-1 (RFC 5737) is routable but never answers.
      host: "192.0.2.1",
    },
    name: "ping",
  });

  const elapsed = Date.now() - startedAt;

  expect(elapsed).toBeLessThan(6_000);
  expect(textOf(result)).toContain("timed out");
}, 30_000);
