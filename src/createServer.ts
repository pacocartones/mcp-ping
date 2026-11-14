import { execFile } from "child_process";
import { FastMCP } from "fastmcp";
import { isIP } from "net";
import { promisify } from "util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const DEFAULT_PING_TIMEOUT_MS = 10_000;

/**
 * RFC 1123 host names: 1-63 character labels of letters, digits and hyphens,
 * never starting or ending with a hyphen, joined by dots. Deliberately strict:
 * anything a shell could interpret (spaces, `;`, `|`, `&`, `$`, backticks,
 * quotes, newlines) and anything `ping` could read as a flag (a leading `-`)
 * is rejected.
 */
const HOSTNAME_PATTERN =
  /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*$/;

const isValidHost = (host: string) =>
  host.length <= 253 && (isIP(host) !== 0 || HOSTNAME_PATTERN.test(host));

/**
 * Accepts either a bare host or a full URL and returns the host part.
 */
const extractHostname = (input: string) => {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    // Strips the brackets that URL keeps around IPv6 literals.
    return new URL(input).hostname.replace(/^\[|\]$/g, "");
  }

  return input;
};

type CreateServerOptions = {
  /**
   * How long a single ping is allowed to run before it is killed.
   */
  pingTimeoutMs?: number;
};

export const createServer = ({
  pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS,
}: CreateServerOptions = {}) => {
  if (
    !Number.isInteger(pingTimeoutMs) ||
    pingTimeoutMs < 1 ||
    pingTimeoutMs > 2_147_483_647
  ) {
    throw new RangeError(
      "pingTimeoutMs must be an integer between 1 and 2147483647",
    );
  }

  const server = new FastMCP({
    name: "Ping Tool",
    version: "1.0.0",
  });

  server.addTool({
    annotations: {
      openWorldHint: false,
      readOnlyHint: true,
      title: "Ping",
    },
    description: "Pings a host and returns the result",
    execute: async (args) => {
      let hostname: string;

      try {
        hostname = extractHostname(args.host);
      } catch {
        return `Invalid host: ${JSON.stringify(args.host)}`;
      }

      if (!isValidHost(hostname)) {
        return `Invalid host: ${JSON.stringify(args.host)}. Expected a host name, an IPv4 address or an IPv6 address.`;
      }

      // Arguments are passed as an array to execFile, so no shell is involved
      // and the host can never be interpreted as a command.
      const pingArgs =
        process.platform === "win32"
          ? ["-n", "4", hostname]
          : ["-c", "4", hostname];

      try {
        const { stderr, stdout } = await execFileAsync("ping", pingArgs, {
          timeout: pingTimeoutMs,
        });

        if (stderr) {
          return `Failed to ping ${hostname}:\n${stderr}`;
        }

        return `Ping results for ${hostname}:\n\n${stdout}`;
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "killed" in error &&
          error.killed === true
        ) {
          return `Ping to ${hostname} timed out after ${pingTimeoutMs}ms`;
        }

        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";

        return `Failed to ping ${hostname}:\n${errorMessage}`;
      }
    },
    name: "ping",
    parameters: z.object({
      host: z
        .string()
        .describe(
          "The hostname or URL to ping (e.g., 'google.com' or 'https://google.com')",
        ),
    }),
  });

  return server;
};
