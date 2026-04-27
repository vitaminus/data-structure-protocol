# DSP v2 — Implementation Plan

(Full combined specification based on our discussion)

## Overview
DSP v2 is a context compiler for AI coding agents that builds a structural + semantic map of a codebase.

---

## Core Concept

AST/LSP indexer  
+ deterministic graph  
+ semantic memory  
+ annotations  
+ MCP server  
+ CLI  
+ incremental updates  

---

## Supported Languages (MVP)

- TypeScript / JavaScript
- Python
- Rust
- Ruby

---

## Core Components

### 1. Indexer
- AST-based parsing (tree-sitter preferred)
- Extract:
  - files, modules, functions, classes
  - imports/exports
  - public API
  - tests
- Stable UID system

---

### 2. Graph Model

Entities + Relations + Provenance

- Deterministic > LLM
- Confidence scoring
- Source tracking (ast, llm, human)

---

### 3. Storage

- SQLite (canonical)
- JSON import/export
- `.dsp/` human-readable export

---

### 4. Semantic Layer

- Optional embeddings
- Cached by content hash
- Supports local or API providers

---

### 5. Impact Analysis

Command:
dsp impact <target>

Outputs:
- direct dependencies
- transitive dependencies
- tests
- risk score

---

### 6. Validation

Command:
dsp validate

Checks:
- broken links
- stale index
- unresolved imports

---

### 7. Git Integration

- diff-based updates
- incremental indexing

Commands:
dsp update --from-git-diff

---

### 8. MCP Server

Provides tools:
- search
- impact
- context pack
- graph traversal

---

## Brownfield Bootstrap

Commands:
dsp bootstrap .
dsp bootstrap . --lazy

Features:
- detects languages
- builds initial graph
- generates report
- safe & resumable

---

## Scalability

Supports:
- 10k+ files
- monorepos

Features:
- incremental indexing
- caching
- parallel parsing
- lazy indexing

---

## Token Efficiency

- No full repo sent to LLM
- Context packs only
- token budgeting
- trimming strategy

---

## CLI

dsp init  
dsp index  
dsp bootstrap  
dsp search  
dsp impact  
dsp validate  
dsp export  
dsp mcp  

---

## Architecture

packages/
  core/
  cli/
  mcp-server/
  language-typescript/
  language-python/
  language-rust/
  language-ruby/

---

## Principles

- Deterministic first
- Provenance everywhere
- Incremental by default
- Human editable
- Agent friendly
- Language-aware precision

---

## Final Goal

DSP v2 = Context Compiler for AI agents

It must produce:
- minimal
- precise
- verifiable

context for coding tasks.
