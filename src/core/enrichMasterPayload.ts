import type { Template } from './schemas';
import type { ParsedPayload } from './payloadValidation';
import { getLearnedSchemaSnapshot } from '../services/schemaLearning';
import { WORD_NUM, SPOKEN_NUM_WORDS, parseSpokenInt as sharedParseSpokenInt } from '../voice/spokenNumbers';

/** Match template rows (including SQLite) when id omits `master-` prefix. */
function inferMasterSchemaId(template: Template): string | null {
  if (template.type !== 'database_entry' || !template.schemaDefinition?.length) return null;
  const keys = new Set(template.schemaDefinition.map(f => f.key));
  if (keys.has('dolphin_count') && keys.has('observation_type')) return 'dolphin_observations';
  if (keys.has('coral_cover_pct') || (keys.has('site_area') && keys.has('transect')))
    return 'coral_reef_health';
  if (
    keys.has('brand') &&
    keys.has('product_type') &&
    keys.has('quantity')
  ) {
    return 'costco_inventory';
  }
  return null;
}

/** Apply enrichment when template maps to a master schema (by id or by column keys). */
export function applyMasterEnrichmentIfNeeded(
  template: Template,
  transcript: string,
  payload: ParsedPayload,
): ParsedPayload {
  let schemaId: string | null = null;
  if (template.type === 'database_entry' && template.id.startsWith('master-')) {
    schemaId = template.id.slice('master-'.length);
  }
  if (!schemaId) {
    schemaId = inferMasterSchemaId(template);
  }
  if (!schemaId) return payload;
  return enrichParsedPayloadForMaster(schemaId, transcript.trim(), payload);
}

// WORD_NUM, SPOKEN_NUM_WORDS, and parseSpokenInt are now shared from src/voice/spokenNumbers.ts.
// The aliases below keep the local call sites unchanged.
const parseSpokenInt = sharedParseSpokenInt;
// Re-export so any callers that imported these directly still compile.
export { WORD_NUM, SPOKEN_NUM_WORDS };

/**
 * Fills `database_entry.fields` from transcript when the LM missed values.
 * Keeps existing non-empty model fields unless they look like placeholders.
 */
export function enrichParsedPayloadForMaster(
  schemaId: string,
  transcript: string,
  payload: ParsedPayload,
): ParsedPayload {
  if (payload.kind !== 'database_entry') return payload;
  const fields = { ...payload.fields };

  switch (schemaId) {
    case 'dolphin_observations':
      return {
        kind: 'database_entry',
        fields: enrichDolphinObservationFields(transcript, fields),
      };
    case 'costco_inventory':
      return {
        kind: 'database_entry',
        fields: enrichCostcoInventoryFields(transcript, fields),
      };
    default:
      return payload;
  }
}

function canonFieldKey(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, '_');
}

/** Map Title Case / stray LM keys onto snake_case Costco columns. */
function normalizeCostcoAliases(
  fields: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = { ...fields };
  const canon = new Set([
    'brand',
    'product_type',
    'product_name',
    'quantity',
  ]);
  const flex = out as Record<string, unknown>;
  for (const [k, v] of Object.entries(flex)) {
    const nk = canonFieldKey(k);
    if (!canon.has(nk)) continue;
    if (nk === k) continue;
    const cur = flex[nk];
    const empty =
      cur == null ||
      cur === '' ||
      (typeof cur === 'string' && !String(cur).trim());
    if (empty && v != null && v !== '') {
      flex[nk] = v;
      if (k !== nk) delete flex[k];
    }
  }
  return flex as Record<string, string | number | boolean | null>;
}

function enrichCostcoInventoryFields(
  transcript: string,
  fields: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  let out = normalizeCostcoAliases({ ...fields });
  const t = transcript.trim();
  const tl = t.toLowerCase();
  const learned = getLearnedSchemaSnapshot('costco_inventory');
  const numOrWord = `(\\d+|${SPOKEN_NUM_WORDS})`;

  const isEmpty = (v: unknown) =>
    v == null ||
    v === '' ||
    (typeof v === 'string' && !v.trim()) ||
    (typeof v === 'number' && !Number.isFinite(v));

  if (isEmpty(out.quantity)) {
    const patterns = [
      new RegExp(`\\b(?:count|quantity|qty)\\.?\\s+(${numOrWord})\\b`, 'i'),
      new RegExp(`\\b(${numOrWord})\\s+(?:units?|cases?|packs?)\\b`, 'i'),
      new RegExp(`\\b(?:about|around|approx(?:imately)?|roughly)\\s+(${numOrWord})\\b`, 'i'),
      new RegExp(`\\b(${numOrWord})\\s+of\\s+them\\b`, 'i'),
      // "three kirkland signature toilet paper units" (number first, "units" later)
      new RegExp(`\\b(${numOrWord})\\b(?:\\s+\\w+){0,8}\\s+(?:units?|items?)\\b`, 'i'),
    ];
    for (const re of patterns) {
      const m = re.exec(t);
      if (m) {
        const n = parseSpokenInt(m[1]);
        if (n !== null) {
          out.quantity = n;
          break;
        }
      }
    }
  }

  if (isEmpty(out.brand)) {
    const bm =
      /\bbrand\s+(.+?)(?=\s+(?:type|product\s+type|product\s+name|count|quantity|qty)\b|$)/i.exec(
        t,
      );
    if (bm) {
      out.brand = bm[1].trim().replace(/\s+/g, ' ');
    }
  }

  if (isEmpty(out.product_type)) {
    const tm =
      /\b(?:type|product\s+type)\s+(.+?)(?=\s+(?:product\s+name|named|called|count|quantity|qty|brand)\b|$)/i.exec(
        t,
      );
    if (tm) {
      out.product_type = tm[1].trim().replace(/\s+/g, ' ');
    }
  }

  if (isEmpty(out.product_name)) {
    const pm =
      /\b(?:product\s+name|called|named|sku)\s+(.+?)(?=\s+(?:count|quantity|qty|type|brand)\b|$)/i.exec(
        t,
      );
    if (pm) {
      out.product_name = pm[1].trim().replace(/\s+/g, ' ');
    }
  }

  // Learned-value matching from historical rows (session cache built at app start).
  const knownBrands = learned?.fields.brand?.textExamples ?? [];
  if (isEmpty(out.brand) && knownBrands.length > 0) {
    const hit = knownBrands.find(v => {
      const n = v.trim().toLowerCase();
      return n.length >= 3 && tl.includes(n);
    });
    if (hit) out.brand = hit;
  }

  const knownTypes = learned?.fields.product_type?.textExamples ?? [];
  if (isEmpty(out.product_type) && knownTypes.length > 0) {
    const hit = knownTypes.find(v => {
      const n = v.trim().toLowerCase();
      return n.length >= 3 && tl.includes(n);
    });
    if (hit) out.product_type = hit;
  }

  // Heuristic: "Kirkland ... toilet paper" without explicit "type"
  if (isEmpty(out.product_type) && /\btoilet\s+paper\b/i.test(t)) {
    out.product_type = 'toilet paper';
  }

  // "Kirkland Signature type toilet paper …" without leading "brand"
  if (isEmpty(out.brand)) {
    const leadType = /^(.+?)\s+type\s+/i.exec(t);
    const chunk = leadType?.[1]?.trim();
    if (chunk && !/^brand\b/i.test(chunk)) {
      out.brand = chunk.replace(/\s+/g, ' ');
    }
  }

  const unknown = (out as Record<string, unknown>).raw;
  if (typeof unknown === 'string' && unknown.trim() && isEmpty(out.brand)) {
    const head = /^([^.\n]+)/.exec(unknown.trim());
    if (head) out.brand = head[1].trim().slice(0, 120);
  }

  delete (out as Record<string, unknown>).raw;
  return out;
}

function enrichDolphinObservationFields(
  transcript: string,
  fields: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = { ...fields };
  const t = transcript.trim();

  const needsCount =
    out.dolphin_count == null ||
    (typeof out.dolphin_count === 'string' && out.dolphin_count.trim() === '') ||
    (typeof out.dolphin_count === 'number' && !Number.isFinite(out.dolphin_count));

  if (needsCount) {
    const numOrWord = `(\\d+|${SPOKEN_NUM_WORDS})`;
    const patterns = [
      new RegExp(`\\b(?:pod\\s*of)\\s*${numOrWord}\\b`, 'i'),
      new RegExp(`\\b${numOrWord}\\s+dolphins?\\b`, 'i'),
      new RegExp(`\\b${numOrWord}\\s+dolphin\\b`, 'i'),
    ];
    for (const re of patterns) {
      const m = re.exec(t);
      if (m) {
        const n = parseSpokenInt(m[1]);
        if (n !== null) {
          out.dolphin_count = n;
          break;
        }
      }
    }
  }

  const locEmpty =
    out.location == null ||
    out.location === '' ||
    (typeof out.location === 'string' && !out.location.trim());
  if (locEmpty) {
    const numOrWord = `(\\d+|${SPOKEN_NUM_WORDS})`;
    const locPatterns = [
      new RegExp(`\\blocation\\s*(?:number\\s*)?${numOrWord}\\b`, 'i'),
      new RegExp(`\\bnear\\s+location\\s*${numOrWord}\\b`, 'i'),
      new RegExp(`\\bat\\s+location\\s*${numOrWord}\\b`, 'i'),
    ];
    for (const re of locPatterns) {
      const m = re.exec(t);
      if (m) {
        const loc = parseSpokenInt(m[1]);
        out.location = loc !== null ? String(loc) : m[1];
        break;
      }
    }
  }

  const typeEmpty =
    !out.observation_type ||
    (typeof out.observation_type === 'string' && !out.observation_type.trim());
  if (typeEmpty && /dolphin/i.test(t)) {
    out.observation_type = 'dolphin';
  }

  const buoyWasEmpty =
    out.buoy == null ||
    out.buoy === '' ||
    (typeof out.buoy === 'string' && !out.buoy.trim());
  if (buoyWasEmpty) {
    const numOrWord = `(\\d+|${SPOKEN_NUM_WORDS})`;
    const m = new RegExp(`\\bbuoy\\s*${numOrWord}\\b`, 'i').exec(t);
    if (m) {
      const b = parseSpokenInt(m[1]);
      out.buoy = b !== null ? String(b) : m[1];
    }
  }
  const buoyStillEmpty =
    out.buoy == null ||
    out.buoy === '' ||
    (typeof out.buoy === 'string' && !out.buoy.trim());
  if (
    buoyStillEmpty &&
    typeof out.location === 'string' &&
    out.location.trim()
  ) {
    out.buoy = out.location.trim();
  }

  delete (out as Record<string, unknown>).raw;

  return out;
}
