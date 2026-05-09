export const SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    topK: { type: "number" }
  },
  required: ["query"]
} as const;

export const UID_INPUT_SCHEMA = {
  type: "object",
  properties: {
    uid: { type: "string" }
  },
  required: ["uid"]
} as const;

export const NEIGHBORS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    uid: { type: "string" },
    depth: { type: "number" },
    maxDepth: { type: "number" },
    maxNodes: { type: "number" },
    maxEntities: { type: "number" },
    maxRelations: { type: "number" },
    maxFiles: { type: "number" },
    maxEstimatedTokens: { type: "number" },
    timeoutMs: { type: "number" }
  },
  required: ["uid"]
} as const;

export const IMPACT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string" },
    maxDepth: { type: "number" },
    maxNodes: { type: "number" },
    maxRelations: { type: "number" },
    timeoutMs: { type: "number" }
  },
  required: ["target"]
} as const;

export const EMPTY_INPUT_SCHEMA = {
  type: "object",
  properties: {}
} as const;

export const PATH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" }
  },
  required: ["from", "to"]
} as const;

export const CONTEXT_PACK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    task: { type: "string" },
    maxTokens: { type: "number" },
    maxFiles: { type: "number" },
    maxDepth: { type: "number" },
    maxNodes: { type: "number" },
    maxRelations: { type: "number" },
    timeoutMs: { type: "number" },
    includeCode: { type: "string" },
    includeTests: { type: "boolean" },
    strategy: { type: "string" }
  },
  required: ["task"]
} as const;
