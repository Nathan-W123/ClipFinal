import type { ClipRecord, Template } from './schemas';

/**
 * Pure record validation. Pass `template` for schema-level type checks.
 * No SQLite imports, no async — safe to call anywhere.
 */
export function validateRecord(
  record: ClipRecord,
  template?: Template,
): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (!record.templateId || !record.templateName || !record.capturedAt) {
    errors.push('missing required fields');
  }
  if (record.payload === undefined || record.payload === null) {
    errors.push('missing payload');
  }

  if (errors.length > 0) return { valid: false, errors };

  // Schema-level type checks when template is provided.
  if (
    template?.type === 'database_entry' &&
    record.payload !== null &&
    typeof record.payload === 'object' &&
    (record.payload as { kind?: string }).kind === 'database_entry'
  ) {
    const fields = (record.payload as { fields?: Record<string, unknown> }).fields ?? {};
    for (const def of template.schemaDefinition) {
      if (def.valueType === 'integer' || def.valueType === 'real') {
        const v = fields[def.key];
        if (v !== null && v !== undefined && typeof v !== 'number') {
          errors.push(`"${def.key}" expects ${def.valueType} but got "${v}"`);
        }
      }
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}
