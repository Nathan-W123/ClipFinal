import type { FieldDefinition, Template } from './schemas';

/** Logical type stored in Postgres / reflected in parser output. */
export type MasterFieldType = 'text' | 'integer' | 'real' | 'boolean';

export type MasterField = FieldDefinition & {
  /** Postgres-style column type for Supabase DDL. */
  pgType: 'text' | 'integer' | 'double precision' | 'boolean';
  valueType: MasterFieldType;
};

export type MasterSchema = {
  id: string;
  /** Human name for docs / UI. */
  displayName: string;
  /** Supabase table name (snake_case, one master table per schema). */
  supabaseTable: string;
  fields: MasterField[];
};

/**
 * One row in any master table shares these metadata columns (plus schema-specific fields).
 * Local SQLite stores a single `parsed_json` blob; sync expands `fields` into columns.
 */
export const MASTER_META_COLUMNS = [
  'id',
  'project_id',
  'raw_transcript',
  'confidence',
  'validated',
  'source',
  'template_id',
  'template_name',
  'created_at',
] as const;

const MASTER_REGISTRY: Record<string, MasterSchema> = {
  dolphin_observations: {
    id: 'dolphin_observations',
    displayName: 'Dolphin observations',
    supabaseTable: 'dolphin_observations',
    fields: [
      {
        key: 'observation_type',
        label: 'Type (e.g. dolphin)',
        pgType: 'text',
        valueType: 'text',
        parser: {
          semanticRole: 'category',
          description: 'Type of sighting (dolphin, whale, turtle, etc.)',
          examples: ['dolphin', 'whale', 'turtle'],
        },
      },
      {
        key: 'dolphin_count',
        label: 'Dolphin count',
        pgType: 'integer',
        valueType: 'integer',
        parser: {
          semanticRole: 'quantity',
          parsePriority: 0,
          description: 'Number of dolphins seen. "pod of 4", "6 dolphins", "saw three" all indicate this field.',
          aliases: ['count', 'pod of', 'saw', 'spotted'],
          examples: ['4', 'six', '12'],
        },
      },
      {
        key: 'location',
        label: 'Location',
        pgType: 'text',
        valueType: 'text',
        parser: {
          semanticRole: 'location',
          description: 'Location number spoken after "location" (e.g. "location 12" → "12")',
          aliases: ['loc', 'near', 'at location'],
          examples: ['12', '3', '7'],
        },
      },
      {
        key: 'buoy',
        label: 'Buoy',
        pgType: 'text',
        valueType: 'text',
        parser: {
          semanticRole: 'identifier',
          description: 'Buoy identifier spoken after "buoy" (e.g. "buoy 5" → "5"); null if not mentioned',
          aliases: ['buoy number'],
          examples: ['5', '2'],
        },
      },
    ],
  },
  coral_reef_health: {
    id: 'coral_reef_health',
    displayName: 'Coral reef health',
    supabaseTable: 'coral_reef_health',
    fields: [
      {
        key: 'site_area',
        label: 'Site / area',
        pgType: 'text',
        valueType: 'text',
        parser: {
          semanticRole: 'location',
          description: 'Named site or area being surveyed (e.g. "North Reef", "Site 3")',
          aliases: ['site', 'area', 'location'],
          examples: ['North Reef', 'Site 3', 'Lagoon A'],
        },
      },
      {
        key: 'transect',
        label: 'Transect',
        pgType: 'text',
        valueType: 'text',
        parser: {
          semanticRole: 'identifier',
          description: 'Transect identifier (number or label)',
          aliases: ['transect number', 'line'],
          examples: ['1', '2', 'T3'],
        },
      },
      {
        key: 'coral_cover_pct',
        label: 'Estimated coral cover %',
        pgType: 'double precision',
        valueType: 'real',
        parser: {
          semanticRole: 'quantity',
          parsePriority: 0,
          description: 'Percentage of coral cover as a decimal number (0–100)',
          aliases: ['cover', 'coral cover', 'coverage'],
          examples: ['45', '72.5', '30'],
        },
      },
      {
        key: 'bleaching_level',
        label: 'Bleaching level (none / mild / moderate / severe)',
        pgType: 'text',
        valueType: 'text',
        parser: {
          semanticRole: 'severity',
          description: 'Bleaching severity: exactly one of none, mild, moderate, severe',
          aliases: ['bleaching', 'bleach level'],
          examples: ['none', 'mild', 'moderate', 'severe'],
        },
      },
      {
        key: 'notes',
        label: 'Notes',
        pgType: 'text',
        valueType: 'text',
        parser: {
          semanticRole: 'notes',
          description: 'Any additional observations not captured by the other fields',
          examples: ['Unusual algae growth', 'High turbidity'],
        },
      },
    ],
  },
  /** Matches `public.costco_inventory` and `supabase/costco_inventory.sql`. */
  costco_inventory: {
    id: 'costco_inventory',
    displayName: 'Costco inventory',
    supabaseTable: 'costco_inventory',
    fields: [
      {
        key: 'brand',
        label: 'Brand',
        pgType: 'text',
        valueType: 'text',
        parser: {
          semanticRole: 'brand',
          description: 'Manufacturer or private-label name (e.g. Kirkland Signature, Charmin, Tide)',
          aliases: ['manufacturer', 'maker', 'Brand:'],
          examples: ['Kirkland Signature', 'Charmin', 'Tide'],
        },
      },
      {
        key: 'product_type',
        label: 'Product type',
        pgType: 'text',
        valueType: 'text',
        parser: {
          semanticRole: 'product_type',
          description: 'Category of product (e.g. toilet paper, chicken, frozen berries, beverages)',
          aliases: ['category', 'type', 'Product type:'],
          examples: ['toilet paper', 'frozen berries', 'chicken', 'beverages'],
        },
      },
      {
        key: 'product_name',
        label: 'Product name',
        pgType: 'text',
        valueType: 'text',
        parser: {
          semanticRole: 'product_name',
          description: 'Specific SKU or product line name if stated (e.g. Ultra Soft, Rotisserie); null if unknown',
          aliases: ['sku', 'called', 'named', 'Product name:'],
          examples: ['Ultra Soft', 'Rotisserie'],
        },
      },
      {
        key: 'quantity',
        label: 'Quantity (units)',
        pgType: 'integer',
        valueType: 'integer',
        parser: {
          semanticRole: 'quantity',
          parsePriority: 0,
          description: 'Integer count of units. A spoken number immediately before or after a product phrase is always quantity, even if listed last in the schema. NEVER put a number in brand or product_type.',
          aliases: ['count', 'qty', 'units', 'how many', 'Quantity:'],
          examples: ['3', 'twelve', '24'],
        },
      },
    ],
  },
};

export function listMasterSchemaIds(): string[] {
  return Object.keys(MASTER_REGISTRY);
}

export function getMasterSchema(id: string | undefined | null): MasterSchema | null {
  if (!id) return null;
  return MASTER_REGISTRY[id] ?? null;
}

export function masterSchemaToTemplate(schemaId: string): Template | null {
  const m = getMasterSchema(schemaId);
  if (!m) return null;
  const schemaDefinition: FieldDefinition[] = m.fields.map(f => ({
    key: f.key,
    label: f.label,
    valueType: f.valueType,
    parser: f.parser,
  }));
  return {
    id: `master-${m.id}`,
    name: m.displayName,
    type: 'database_entry',
    schemaDefinition,
  };
}

/** Coerce parser `fields` values toward schema types for DB / Supabase. */
export function coerceFieldValues(
  schemaId: string,
  fields: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const m = getMasterSchema(schemaId);
  if (!m) return fields;
  const out: Record<string, string | number | boolean | null> = {};
  for (const f of m.fields) {
    const v = fields[f.key];
    if (v === undefined) {
      out[f.key] = null;
      continue;
    }
    if (v === null) {
      out[f.key] = null;
      continue;
    }
    if (f.valueType === 'integer') {
      const n = typeof v === 'number' ? Math.round(v) : parseInt(String(v), 10);
      out[f.key] = Number.isFinite(n) ? n : null;
    } else if (f.valueType === 'real') {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      out[f.key] = Number.isFinite(n) ? n : null;
    } else if (f.valueType === 'boolean') {
      out[f.key] = Boolean(v);
    } else {
      out[f.key] = typeof v === 'string' ? v : String(v);
    }
  }
  return out;
}
