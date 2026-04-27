import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import type { DSPServices } from "@dsp/core";
import {
  getNeighbors,
  runChanged,
  runContextPack,
  runImpact,
  runSearch,
  runValidate
} from "@dsp/core";

export const TOOLS: Tool[] = [
  {
    name: "dsp.search",
    description: "Lexical graph search",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        topK: { type: "number" }
      },
      required: ["query"]
    }
  },
  {
    name: "dsp.semantic_search",
    description: "Semantic + lexical graph search",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        topK: { type: "number" }
      },
      required: ["query"]
    }
  },
  {
    name: "dsp.get_entity",
    description: "Get entity by uid",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string" }
      },
      required: ["uid"]
    }
  },
  {
    name: "dsp.get_neighbors",
    description: "Get entity neighbors",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string" },
        depth: { type: "number" }
      },
      required: ["uid"]
    }
  },
  {
    name: "dsp.impact",
    description: "Run impact analysis",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"]
    }
  },
  {
    name: "dsp.validate",
    description: "Validate graph and index",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "dsp.explain_path",
    description: "Explain path in graph from one entity to another",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" }
      },
      required: ["from", "to"]
    }
  },
  {
    name: "dsp.list_changed",
    description: "List changed files in git scope",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "dsp.get_context_pack",
    description: "Build bounded context pack for a coding task",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        maxTokens: { type: "number" },
        maxFiles: { type: "number" },
        maxDepth: { type: "number" },
        includeCode: { type: "string" },
        includeTests: { type: "boolean" },
        strategy: { type: "string" }
      },
      required: ["task"]
    }
  }
];

function jsonText(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

function shortestPath(
  services: DSPServices,
  from: string,
  to: string
): { nodes: string[]; found: boolean } {
  const queue: string[] = [from];
  const parents = new Map<string, string | null>();
  parents.set(from, null);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === to) {
      break;
    }
    for (const rel of services.db.getRelationsFrom(current)) {
      if (!parents.has(rel.to)) {
        parents.set(rel.to, current);
        queue.push(rel.to);
      }
    }
  }
  if (!parents.has(to)) {
    return { nodes: [], found: false };
  }
  const nodes: string[] = [];
  let cursor: string | null = to;
  while (cursor) {
    nodes.push(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  nodes.reverse();
  return { nodes, found: true };
}

export async function startMcpServer(services: DSPServices): Promise<void> {
  const server = new Server(
    {
      name: "dsp-v2",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    dispatchToolCall(services, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>)
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function dispatchToolCall(
  services: DSPServices,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  switch (name) {
    case "dsp.search":
    case "dsp.semantic_search": {
      const query = String(args.query ?? "");
      const topK = typeof args.topK === "number" ? args.topK : 20;
      const results = await runSearch(services, query, {
        topK,
        embeddingsEnabled: name === "dsp.semantic_search"
      });
      return { content: [jsonText(results)] };
    }
    case "dsp.get_entity": {
      const uid = String(args.uid ?? "");
      return { content: [jsonText(services.db.getEntity(uid) ?? null)] };
    }
    case "dsp.get_neighbors": {
      const uid = String(args.uid ?? "");
      const depth = typeof args.depth === "number" ? args.depth : 1;
      return { content: [jsonText(getNeighbors(services.db, uid, depth))] };
    }
    case "dsp.impact": {
      const target = String(args.target ?? "");
      return { content: [jsonText(runImpact(services, target))] };
    }
    case "dsp.validate": {
      return { content: [jsonText(runValidate(services))] };
    }
    case "dsp.explain_path": {
      const from = String(args.from ?? "");
      const to = String(args.to ?? "");
      return { content: [jsonText(shortestPath(services, from, to))] };
    }
    case "dsp.list_changed": {
      const changed = runChanged(services);
      return { content: [jsonText(changed)] };
    }
    case "dsp.get_context_pack": {
      const pack = await runContextPack(services, {
        task: String(args.task ?? ""),
        maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined,
        maxFiles: typeof args.maxFiles === "number" ? args.maxFiles : undefined,
        maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : undefined,
        includeCode: (args.includeCode as "none" | "snippets-only" | "full-files") ?? "snippets-only",
        includeTests: typeof args.includeTests === "boolean" ? args.includeTests : true,
        strategy: (args.strategy as "minimal" | "balanced" | "deep" | "debug") ?? "minimal"
      });
      return { content: [jsonText(pack)] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
