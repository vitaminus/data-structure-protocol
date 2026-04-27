# Language Adapters

Each adapter implements:

```ts
interface LanguageAdapter {
  language: string;
  canHandle(filePath: string): boolean;
  parseFile(filePath: string, content: string): Promise<ParseResult>;
  extractEntities(parseResult: ParseResult): Entity[];
  extractRelations(parseResult: ParseResult, entities: Entity[]): Relation[];
  extractPublicAPI(entities: Entity[]): Entity[];
}
```

## TypeScript/JavaScript

- TypeScript Compiler API
- imports/exports/functions/classes/methods/interfaces/types

## Python

- Python AST via subprocess (`python3 -c`) with fallback parser
- imports/classes/functions/methods/docstrings

## Rust

- Rust syntax-aware extraction for `mod/use/pub/struct/enum/trait/impl/fn`
- handles `impl Trait for Struct` relation

## Ruby

- Ruby syntax-aware extraction for class/module/method/include/extend/require
- supports `class << self` and route extraction from `config/routes.rb`
- uncertain dynamic edges are marked lower confidence
