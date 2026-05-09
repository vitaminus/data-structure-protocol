export type EntityKind =
  | "repository"
  | "directory"
  | "file"
  | "module"
  | "function"
  | "class"
  | "method"
  | "type"
  | "interface"
  | "constant"
  | "route"
  | "test"
  | "unknown";

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type EntityUid<K extends EntityKind = EntityKind> = Brand<string, `entity:${K}`>;

export type FileUid = EntityUid<"file">;

export type RelationKind =
  | "contains"
  | "imports"
  | "exports"
  | "calls"
  | "extends"
  | "implements"
  | "uses"
  | "tests"
  | "routes_to"
  | "depends_on"
  | "similar_to"
  | "annotates";

export type ProvenanceSource = "ast" | "lsp" | "regex" | "git" | "test" | "llm" | "human";

export type Provenance = {
  source: ProvenanceSource;
  tool?: string;
  timestamp: string;
  confidence: number;
  evidence?: string;
};

export type Entity = {
  uid: string;
  kind: EntityKind;
  name: string;
  path?: string;
  language?: string;
  signature?: string;
  startLine?: number;
  endLine?: number;
  description?: string;
  docstring?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  provenance: Provenance[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

export type Relation = {
  from: string;
  to: string;
  kind: RelationKind;
  reason?: string;
  weight?: number;
  confidence: number;
  provenance: Provenance[];
  metadata?: Record<string, unknown>;
};

export type UnresolvedReference = {
  path: string;
  fromUid?: string;
  symbol: string;
  kind: "import" | "use" | "require" | "call" | "type" | "unknown";
  reason?: string;
  confidence: number;
};

export type ParseResult = {
  entities: Entity[];
  relations: Relation[];
  unresolvedReferences?: UnresolvedReference[];
};

export type LanguageAdapterWorkerSpec = {
  moduleUrl: string;
  exportName: string;
};

export type LanguageAdapter = {
  language: string;
  worker?: LanguageAdapterWorkerSpec;
  canHandle(filePath: string): boolean;
  parseFile(filePath: string, content: string): Promise<ParseResult>;
  extractEntities(parseResult: ParseResult): Entity[];
  extractRelations(parseResult: ParseResult, entities: Entity[]): Relation[];
  extractPublicAPI(entities: Entity[]): Entity[];
};

export type EmbeddingProvider = {
  embed(text: string): Promise<number[]>;
  cacheKey?: () => string;
};

export type SearchResult = {
  uid: string;
  kind: EntityKind;
  path?: string;
  score: number;
  explanation: string;
  neighbors: string[];
};

export type ImpactResult = {
  target: string;
  directDependents: string[];
  transitiveDependents: string[];
  testsAffected: string[];
  publicApiAffected: boolean;
  riskScore: "LOW" | "MEDIUM" | "HIGH";
  suggestedFiles: string[];
  confidence: number;
  reasons: string[];
};

export type ValidationSeverity = "error" | "warning" | "info";

export type ValidationIssue = {
  kind:
    | "missing_file"
    | "stale_hash"
    | "dangling_relation"
    | "unresolved_reference"
    | "low_confidence_critical"
    | "annotation_conflict";
  severity: ValidationSeverity;
  message: string;
  path?: string;
  uid?: string;
  relation?: { from: string; to: string; kind: RelationKind };
  confidence?: number;
};

export type ValidationSummary = {
  total: number;
  errors: number;
  warnings: number;
  info: number;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
  summary: ValidationSummary;
};

export type ValidationOptions = {
  changedOnly?: boolean;
  deep?: boolean;
};

export type RepairAction = {
  kind: ValidationIssue["kind"];
  status: "planned" | "applied" | "skipped";
  message: string;
  path?: string;
  uid?: string;
  relation?: { from: string; to: string; kind: RelationKind };
};

export type RepairResult = {
  dryRun: boolean;
  actions: RepairAction[];
  validationBefore: ValidationSummary;
  validationAfter?: ValidationSummary;
};

export type ContextPackRequest = {
  task: string;
  maxTokens?: number;
  maxFiles?: number;
  maxDepth?: number;
  includeCode?: "none" | "snippets-only" | "full-files";
  includeTests?: boolean;
  strategy?: "minimal" | "balanced" | "deep" | "debug";
};

export type ContextPackResponse = {
  relevantEntities: Entity[];
  files: string[];
  dependencies: Relation[];
  tests: Entity[];
  code?: {
    path: string;
    mode: "snippets-only" | "full-files";
    content: string;
    startLine?: number;
    endLine?: number;
    truncated: boolean;
  }[];
  riskNotes: string[];
  suggestedEditOrder: string[];
  estimatedTokens: number;
  maxTokens: number;
  truncated: boolean;
};

export type IndexMode = "index" | "update" | "bootstrap";

export type FileIndexRequest = {
  rootDir: string;
  files?: string[];
  lazy?: boolean;
  full?: boolean;
  changedOnly?: boolean;
  fromGitDiff?: boolean;
  baseRef?: string;
  noEmbeddings?: boolean;
};

export type IndexSummary = {
  mode: IndexMode;
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  languages: string[];
  entities: number;
  relations: number;
  unresolvedReferences: number;
  lowConfidenceRelations: number;
  estimatedCoverage: number;
  telemetry?: {
    parserFallbackFiles: number;
    fallbackByLanguage: Record<string, number>;
    parserSourceCounts: Record<string, number>;
  };
};
