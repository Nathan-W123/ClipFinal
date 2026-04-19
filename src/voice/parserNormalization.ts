import type { FieldDefinition, FieldSemanticRole, Template } from '../core/schemas';
import type { ParseIssue } from './cactus';
import { parseSpokenInt, parseSpokenFloat } from './spokenNumbers';

// Semantic role priority for LLM-facing prompt ordering (lower = first).
const ROLE_RANK: Record<FieldSemanticRole, number> = {
  quantity: 0,
  brand: 1,
  product_type: 2,
  product_name: 3,
  identifier: 4,
  category: 4,
  location: 4,
  severity: 5,
  notes: 5,
};

function roleRank(def: FieldDefinition): number {
  const role = def.parser?.semanticRole;
  if (role) return ROLE_RANK[role] ?? 6;
  return 6;
}

/** Returns fields sorted for the LLM prompt (quantity first etc). Does not affect save order. */
export function buildPriorityOrderedFields(defs: FieldDefinition[]): FieldDefinition[] {
  return [...defs].sort((a, b) => {
    const pa = a.parser?.parsePriority ?? (roleRank(a) * 100 + defs.indexOf(a));
    const pb = b.parser?.parsePriority ?? (roleRank(b) * 100 + defs.indexOf(b));
    return pa - pb;
  });
}

/**
 * Post-parse normalization for database_entry payloads.
 *
 * Runs after the LLM returns JSON. Handles:
 *   1. Key whitelist + alias/label resolution → canonical keys
 *   2. Spoken-number coercion for integer/real fields
 *   3. Role-aware slot-swap repair (number landed in brand/product field)
 *   4. Rejection of non-numeric strings in numeric slots
 *   5. Null-fill for missing keys
 *   6. Reorder output to template field order
 */
export function normalizeLmResult(
  template: Template,
  rawFields: Record<string, unknown>,
  _transcript: string,
): { fields: Record<string, string | number | boolean | null>; issues: ParseIssue[] } {
  if (template.type !== 'database_entry') {
    return { fields: {}, issues: [] };
  }

  const defs = template.schemaDefinition;
  const issues: ParseIssue[] = [];

  // Build lookup maps for alias resolution.
  const canonicalKeys = new Set(defs.map(d => d.key));
  // label → key (case-insensitive)
  const labelToKey = new Map<string, string>();
  // alias → key (case-insensitive)
  const aliasToKey = new Map<string, string>();

  for (const def of defs) {
    labelToKey.set(def.label.toLowerCase(), def.key);
    if (def.parser?.aliases) {
      for (const alias of def.parser.aliases) {
        aliasToKey.set(alias.toLowerCase(), def.key);
      }
    }
  }

  // --- Step 1: Key whitelist + alias/label resolution ---
  const resolved: Record<string, unknown> = {};

  for (const [rawKey, rawVal] of Object.entries(rawFields)) {
    const lk = rawKey.toLowerCase().trim();
    if (canonicalKeys.has(rawKey)) {
      // Exact match
      resolved[rawKey] = rawVal;
    } else if (labelToKey.has(lk)) {
      // Label match (e.g. "Quantity (units)" → "quantity")
      const canonical = labelToKey.get(lk)!;
      resolved[canonical] = rawVal;
      issues.push({
        field: canonical,
        severity: 'warning',
        code: 'semantic_repair_applied',
        message: `Field key "${rawKey}" matched by label → remapped to "${canonical}"`,
        rawValue: typeof rawVal === 'string' || typeof rawVal === 'number' || typeof rawVal === 'boolean' ? rawVal : undefined,
      });
    } else if (aliasToKey.has(lk)) {
      // Alias match
      const canonical = aliasToKey.get(lk)!;
      resolved[canonical] = rawVal;
      issues.push({
        field: canonical,
        severity: 'warning',
        code: 'semantic_repair_applied',
        message: `Field key "${rawKey}" matched by alias → remapped to "${canonical}"`,
        rawValue: typeof rawVal === 'string' || typeof rawVal === 'number' || typeof rawVal === 'boolean' ? rawVal : undefined,
      });
    } else {
      // Unknown key — drop it
      issues.push({
        field: rawKey,
        severity: 'warning',
        code: 'unknown_field',
        message: `Unknown field "${rawKey}" returned by LLM — dropped`,
        rawValue: typeof rawVal === 'string' || typeof rawVal === 'number' || typeof rawVal === 'boolean' ? rawVal : undefined,
      });
    }
  }

  // --- Step 2: Spoken-number coercion for integer/real fields ---
  const coerced: Record<string, unknown> = { ...resolved };

  for (const def of defs) {
    const val = coerced[def.key];
    if (val === undefined || val === null) continue;

    if (def.valueType === 'integer') {
      if (typeof val === 'number') {
        coerced[def.key] = Math.round(val);
      } else {
        const n = parseSpokenInt(val);
        if (n !== null) {
          if (typeof val === 'string' && /^\d+$/.test(val.trim()) === false) {
            // It was a word-number — note the repair
            issues.push({
              field: def.key,
              severity: 'warning',
              code: 'semantic_repair_applied',
              message: `Spoken number "${val}" coerced to integer ${n}`,
              rawValue: typeof val === 'string' ? val : undefined,
            });
          }
          coerced[def.key] = n;
        } else {
          // Non-numeric string in integer field
          issues.push({
            field: def.key,
            severity: 'error',
            code: 'type_mismatch',
            message: `Field "${def.key}" expects integer but got "${val}"`,
            rawValue: typeof val === 'string' || typeof val === 'boolean' ? val : undefined,
          });
          coerced[def.key] = null;
        }
      }
    } else if (def.valueType === 'real') {
      if (typeof val === 'number') {
        // already numeric, keep as-is
      } else {
        const n = parseSpokenFloat(val);
        if (n !== null) {
          coerced[def.key] = n;
        } else {
          issues.push({
            field: def.key,
            severity: 'error',
            code: 'type_mismatch',
            message: `Field "${def.key}" expects number but got "${val}"`,
            rawValue: typeof val === 'string' || typeof val === 'boolean' ? val : undefined,
          });
          coerced[def.key] = null;
        }
      }
    }
  }

  // --- Step 3: Role-aware slot-swap repair ---
  // If a quantity-role field is null/missing but a numeric value landed in a
  // brand/product_type/product_name field, move it to the quantity slot.
  const quantityDef = defs.find(d => d.parser?.semanticRole === 'quantity');
  if (quantityDef) {
    const qVal = coerced[quantityDef.key];
    const qMissing = qVal === undefined || qVal === null;

    if (qMissing) {
      const textRoles: FieldSemanticRole[] = ['brand', 'product_type', 'product_name'];
      for (const def of defs) {
        if (!def.parser?.semanticRole || !textRoles.includes(def.parser.semanticRole)) continue;
        const v = coerced[def.key];
        if (typeof v === 'number' && Number.isFinite(v)) {
          // A number landed in a text-role field — swap it to quantity
          coerced[quantityDef.key] = v;
          coerced[def.key] = null;
          issues.push({
            field: quantityDef.key,
            severity: 'warning',
            code: 'semantic_repair_applied',
            message: `Numeric value ${v} found in "${def.key}" (${def.parser.semanticRole}) — moved to quantity field "${quantityDef.key}"`,
            rawValue: v,
          });
          break;
        }
      }
    }
  }

  // --- Step 4: Reject any remaining non-numeric in numeric slots (post-coercion safety) ---
  for (const def of defs) {
    if (def.valueType !== 'integer' && def.valueType !== 'real') continue;
    const v = coerced[def.key];
    if (v !== null && v !== undefined && typeof v !== 'number') {
      issues.push({
        field: def.key,
        severity: 'error',
        code: 'type_mismatch',
        message: `Field "${def.key}" expects numeric but got "${v}" after coercion`,
        rawValue: typeof v === 'string' || typeof v === 'boolean' ? v : undefined,
      });
      coerced[def.key] = null;
    }
  }

  // --- Step 5 & 6: Null-fill missing keys and reorder to template field order ---
  const fields: Record<string, string | number | boolean | null> = {};
  for (const def of defs) {
    const v = coerced[def.key];
    if (v === undefined) {
      fields[def.key] = null;
    } else if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      fields[def.key] = v;
    } else {
      // Objects / arrays — stringify as fallback
      fields[def.key] = JSON.stringify(v);
    }
  }

  return { fields, issues };
}
