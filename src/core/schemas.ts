// Shared types for templates, captures, and validation — kept small for Expo bundle.

export type FieldSemanticRole =
  | 'quantity'
  | 'brand'
  | 'product_type'
  | 'product_name'
  | 'identifier'
  | 'category'
  | 'location'
  | 'severity'
  | 'notes';

export interface FieldParserHints {
  /** Semantic meaning — used for slot-swap repair and prompt ordering. */
  semanticRole?: FieldSemanticRole;
  /** Injected verbatim into the LLM prompt as a field description. */
  description?: string;
  /** Alternative keys/labels the LLM may return; normalized back to canonical key. */
  aliases?: string[];
  /** Concrete values shown in the prompt to calibrate the LM. */
  examples?: string[];
  /** Lower = earlier in LLM-facing prompt; 0 = first. Does not affect saved field order. */
  parsePriority?: number;
}

export interface FieldDefinition {
  key: string;
  label: string;
  /** When set, the parser can ask the LM to use the right JSON type (number vs string). */
  valueType?: 'text' | 'integer' | 'real' | 'boolean';
  /** Optional semantic hints used by the normalization layer and prompt builder. */
  parser?: FieldParserHints;
}

export type Template =
  | { id: string; name: string; type: 'checklist' }
  | { id: string; name: string; type: 'notes' }
  | {
      id: string;
      name: string;
      type: 'database_entry';
      schemaDefinition: FieldDefinition[];
    };

export interface ClipRecord {
  id: string;
  templateId: string;
  templateName: string;
  payload: unknown;
  rawTranscript: string;
  confidenceScore: number;
  validated: boolean;
  synced: boolean;
  capturedAt: string;
  /**
   * When set, equals `MasterSchema.supabaseTable` / schema id — row syncs to that Supabase master table.
   * When null, row syncs to the legacy `captures` table.
   */
  masterTable?: string | null;
}
