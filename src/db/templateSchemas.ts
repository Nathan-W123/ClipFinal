import type { SQLiteDatabase } from 'expo-sqlite';
import type { FieldDefinition, Template } from '../core/schemas';
import { getTemplateById } from '../core/templates';
import {
  getMasterSchema,
  listMasterSchemaIds,
  type MasterField,
} from '../core/masterSchemas';

export type TemplateSchemaRow = {
  id: string;
  display_name: string;
  template_kind: string;
  master_schema_id: string | null;
  fields_json: string;
  prompt_hint: string | null;
  supabase_table?: string | null;
};

/** Database-entry templates tied to a master schema (includes rows synced from Supabase `template_catalog`). */
export type DatabaseTemplateOption = {
  id: string;
  displayName: string;
  masterSchemaId: string;
};

function fieldsToJson(fields: MasterField[]): string {
  const defs: FieldDefinition[] = fields.map(f => ({
    key: f.key,
    label: f.label,
    valueType: f.valueType,
    parser: f.parser,
  }));
  return JSON.stringify(defs);
}

function rowToTemplate(row: TemplateSchemaRow): Template | null {
  const kind = row.template_kind;
  if (kind === 'checklist') {
    return { id: row.id, name: row.display_name, type: 'checklist' };
  }
  if (kind === 'notes') {
    return { id: row.id, name: row.display_name, type: 'notes' };
  }
  if (kind === 'database_entry') {
    try {
      const defs = JSON.parse(row.fields_json) as FieldDefinition[];
      const schemaDefinition = Array.isArray(defs) ? defs : [];
      // Re-inject parser hints from the local master registry so Supabase syncs
      // (which don't include parser hints) don't lose semantic metadata.
      if (row.master_schema_id) {
        const master = getMasterSchema(row.master_schema_id);
        if (master) {
          const hintMap = new Map(master.fields.map(f => [f.key, f.parser]));
          for (const def of schemaDefinition) {
            if (!def.parser) def.parser = hintMap.get(def.key);
          }
        }
      }
      return {
        id: row.id,
        name: row.display_name,
        type: 'database_entry',
        schemaDefinition,
      };
    } catch {
      return {
        id: row.id,
        name: row.display_name,
        type: 'database_entry',
        schemaDefinition: [],
      };
    }
  }
  return null;
}

/** Load a template from the local catalog (seeded at migrate time). Falls back to null if missing. */
export async function getTemplateFromDatabase(
  db: SQLiteDatabase,
  templateId: string,
): Promise<Template | null> {
  try {
    const row = await db.getFirstAsync<TemplateSchemaRow>(
      `SELECT id, display_name, template_kind, master_schema_id, fields_json, prompt_hint
       FROM template_schemas WHERE id = ?`,
      templateId,
    );
    if (!row) return null;
    return rowToTemplate(row);
  } catch {
    return null;
  }
}

async function templateSchemasHasColumn(
  db: SQLiteDatabase,
  column: string,
): Promise<boolean> {
  const rows = await db.getAllAsync<{ name: string }>(
    `PRAGMA table_info(template_schemas)`,
  );
  return rows.some(r => r.name === column);
}

/** Rows suitable for the Create → Data Collection template picker. */
export async function listDatabaseTemplateOptions(
  db: SQLiteDatabase,
): Promise<DatabaseTemplateOption[]> {
  try {
    const rows = await db.getAllAsync<{
      id: string;
      display_name: string;
      master_schema_id: string | null;
    }>(
      `SELECT id, display_name, master_schema_id FROM template_schemas
       WHERE template_kind = 'database_entry'
         AND master_schema_id IS NOT NULL
       ORDER BY display_name COLLATE NOCASE`,
    );
    return rows
      .filter((r): r is typeof r & { master_schema_id: string } => !!r.master_schema_id)
      .map(r => ({
        id: r.id,
        displayName: r.display_name,
        masterSchemaId: r.master_schema_id,
      }));
  } catch {
    return [];
  }
}

/** Prefer SQLite catalog; fall back to in-memory defaults (src/core/templates.ts). */
export async function getTemplateByIdWithDb(
  db: SQLiteDatabase,
  templateId: string | undefined,
): Promise<Template | null> {
  if (!templateId) return null;
  const fromDb = await getTemplateFromDatabase(db, templateId);
  return fromDb ?? getTemplateById(templateId);
}

export async function seedTemplateSchemas(db: SQLiteDatabase): Promise<void> {
  const rows: Array<{
    id: string;
    display_name: string;
    template_kind: string;
    master_schema_id: string | null;
    fields_json: string;
    prompt_hint: string | null;
  }> = [];

  for (const schemaId of listMasterSchemaIds()) {
    const m = getMasterSchema(schemaId);
    if (!m) continue;
    rows.push({
      id: `master-${m.id}`,
      display_name: m.displayName,
      template_kind: 'database_entry',
      master_schema_id: m.id,
      fields_json: fieldsToJson(m.fields),
      prompt_hint: null,
    });
  }

  rows.push(
    {
      id: 'tmpl-checklist',
      display_name: 'Checklist',
      template_kind: 'checklist',
      master_schema_id: null,
      fields_json: '[]',
      prompt_hint: null,
    },
    {
      id: 'tmpl-notes',
      display_name: 'Notes',
      template_kind: 'notes',
      master_schema_id: null,
      fields_json: '[]',
      prompt_hint: null,
    },
    {
      id: 'tmpl-data-collection',
      display_name: 'Data Collection',
      template_kind: 'database_entry',
      master_schema_id: null,
      fields_json: '[]',
      prompt_hint: null,
    },
  );

  for (const r of rows) {
    await db.runAsync(
      `INSERT OR REPLACE INTO template_schemas (
        id, display_name, template_kind, master_schema_id, fields_json, prompt_hint
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      r.id,
      r.display_name,
      r.template_kind,
      r.master_schema_id,
      r.fields_json,
      r.prompt_hint,
    );
  }
}

export async function migrateTemplateSchemas(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS template_schemas (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      template_kind TEXT NOT NULL,
      master_schema_id TEXT,
      fields_json TEXT NOT NULL DEFAULT '[]',
      prompt_hint TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_template_schemas_master ON template_schemas(master_schema_id);
  `);
  if (!(await templateSchemasHasColumn(db, 'supabase_table'))) {
    await db.execAsync(`ALTER TABLE template_schemas ADD COLUMN supabase_table TEXT`);
  }
  await seedTemplateSchemas(db);
}
