import type { Provenance, ProvenanceSource } from "./types.js";
export declare function sourcePriority(source: ProvenanceSource): number;
export declare function topSourcePriority(provenance: Provenance[]): number;
export declare function mergeProvenance(existing: Provenance[], incoming: Provenance[]): Provenance[];
//# sourceMappingURL=provenance.d.ts.map