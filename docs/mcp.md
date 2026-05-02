# MCP

DSP v2 MCP tools:

- `dsp.search`
- `dsp.semantic_search`
- `dsp.get_entity`
- `dsp.get_neighbors`
- `dsp.impact`
- `dsp.validate`
- `dsp.explain_path`
- `dsp.list_changed`
- `dsp.get_context_pack`

## Context pack request

```json
{
  "task": "Add SMS reminders for appointments",
  "maxTokens": 8000,
  "maxFiles": 20,
  "maxDepth": 2,
  "includeCode": "snippets-only",
  "includeTests": true,
  "strategy": "minimal"
}
```

Response includes selected entities/files/dependencies plus token estimate and truncation metadata.

## Neighbor request

```json
{
  "uid": "function:src/auth.ts#login",
  "depth": 2,
  "maxEntities": 100,
  "maxRelations": 250,
  "maxFiles": 20,
  "maxEstimatedTokens": 4000
}
```

Neighbor traversal is budgeted and priority-ordered by relation weight, confidence, and relation kind.
