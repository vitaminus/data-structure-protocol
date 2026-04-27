# Graph Schema

## Entity

- `uid`
- `kind`
- `name`
- `path`
- `language`
- `signature`
- `startLine`, `endLine`
- `description`, `docstring`
- `tags`, `metadata`
- `provenance[]`
- `confidence`
- `createdAt`, `updatedAt`

## Relation

- `from`
- `to`
- `kind`
- `reason`
- `weight`
- `confidence`
- `provenance[]`
- `metadata`

## Provenance sources

- `ast`
- `lsp`
- `regex`
- `git`
- `test`
- `llm`
- `human`

Priority:

`human > ast/lsp > regex > llm`
