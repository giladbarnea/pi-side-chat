// A local stdio MCP server for tests: one `echo` tool that answers `echo:<text>`. No network.
import { createInterface } from "node:readline";

const TOOLS = [
	{
		name: "echo",
		description: "Echo the text back",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
];

const RESULTS = {
	initialize: (params) => ({
		protocolVersion: params.protocolVersion,
		capabilities: { tools: {} },
		serverInfo: { name: "fake", version: "1.0.0" },
	}),
	ping: () => ({}),
	"tools/list": () => ({ tools: TOOLS }),
	"tools/call": (params) => ({ content: [{ type: "text", text: `echo:${params.arguments.text}` }] }),
};

for await (const line of createInterface({ input: process.stdin })) {
	const message = JSON.parse(line);
	if (message.id === undefined) continue;
	const result = RESULTS[message.method];
	const reply = result
		? { jsonrpc: "2.0", id: message.id, result: result(message.params) }
		: { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
	process.stdout.write(`${JSON.stringify(reply)}\n`);
}
