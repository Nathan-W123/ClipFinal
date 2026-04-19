// Types for on-device parse results (Gemma / Cactus). Stub hook fills these today.

export interface ParseIssue {
  /** Canonical field key the issue applies to; empty string for record-level issues. */
  field: string;
  severity: 'warning' | 'error';
  code:
    | 'unknown_field'
    | 'missing_required'
    | 'type_mismatch'
    | 'enum_mismatch'
    | 'range_violation'
    | 'semantic_repair_applied'
    | 'low_confidence';
  message: string;
  /** The raw value the LM returned before normalization (if relevant). */
  rawValue?: string | number | boolean;
}

export interface ParseResult {
  record: {
    templateId: string;
    templateName: string;
    payload: unknown;
    rawTranscript: string;
  };
  confidence: number;
  latencyMs: number;
  /** Normalization and validation issues found during parsing. Empty array = clean parse. */
  issues: ParseIssue[];
}
