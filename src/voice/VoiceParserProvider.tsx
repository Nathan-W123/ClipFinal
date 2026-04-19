import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Platform } from 'react-native';
import { useCactusLM } from 'cactus-react-native';
import type { FieldSemanticRole, Template } from '../core/schemas';
import { applyMasterEnrichmentIfNeeded } from '../core/enrichMasterPayload';
import { fallbackPayload, validateParsedPayload } from '../core/payloadValidation';
import { transcribeAudioFile } from '../services/transcribe';
import { getLearnedSchemaSnapshot } from '../services/schemaLearning';
import { buildPriorityOrderedFields, normalizeLmResult } from './parserNormalization';
import { WORD_NUM } from './spokenNumbers';
import type { ParseIssue, ParseResult } from './cactus';

const MODEL_ID =
  process.env.EXPO_PUBLIC_CACTUS_MODEL ?? 'google/gemma-4-E2B-it';

function extractJsonObject(text: string): string {
  let t = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)```$/m.exec(t);
  if (fenced) {
    t = fenced[1].trim();
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return t.slice(start, end + 1);
  }
  return t;
}

function jsonSchemaPrompt(template: Template): string {
  switch (template.type) {
    case 'checklist':
      return `Return a single JSON object only:
{"kind":"checklist","steps":[{"title":"string","notes":"string","completed":boolean}],"summary":"string"}
Use short titles for steps inferred from the transcript.`;
    case 'notes':
      return `Return a single JSON object only:
{"kind":"notes","body":"string","title":"optional string"}
Put the main content in body.`;
    case 'database_entry': {
      const defs = template.schemaDefinition ?? [];
      if (defs.length === 0) {
        return `Return a single JSON object only:
{"kind":"database_entry","fields":{"key":"value",...}}
Use string values unless clearly numeric or boolean.`;
      }

      // Order fields by parsePriority / semantic role so quantity fields appear first.
      const ordered = buildPriorityOrderedFields(defs);

      const spokeNumMap = Object.entries(WORD_NUM)
        .filter(([k]) => k !== 'zero')
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');

      const fieldLines = ordered.map(f => {
        const typeHint = f.valueType ? ` [${f.valueType}]` : '';
        const parts: string[] = [`  "${f.key}"${typeHint}: <${f.label}>`];
        if (f.parser?.description) parts.push(`  // ${f.parser.description}`);
        if (f.parser?.aliases?.length) parts.push(`  // aliases: ${f.parser.aliases.join(', ')}`);
        if (f.parser?.examples?.length) parts.push(`  // e.g. ${f.parser.examples.join(', ')}`);
        return parts.join('\n');
      });

      // Generate dynamic few-shot examples for quantity + brand + product role groups.
      const quantityDef = ordered.find(f => f.parser?.semanticRole === 'quantity');
      const brandDef    = ordered.find(f => f.parser?.semanticRole === ('brand' as FieldSemanticRole));
      const ptDef       = ordered.find(f => f.parser?.semanticRole === ('product_type' as FieldSemanticRole));
      const pnDef       = ordered.find(f => f.parser?.semanticRole === ('product_name' as FieldSemanticRole));

      let fewShot = '';
      if (quantityDef && brandDef && ptDef) {
        const qk = quantityDef.key;
        const bk = brandDef.key;
        const tk = ptDef.key;
        const pk = pnDef?.key ?? null;
        const nullPn = pk ? `,"${pk}":null` : '';
        const nullPt = pk ? `,"${tk}":null` : '';

        fewShot = `
Examples (always use exact snake_case field keys — never use label names as keys):
Input: "three Kirkland Signature chickens"
→ {"kind":"database_entry","fields":{"${qk}":3,"${bk}":"Kirkland Signature","${tk}":"chickens"${nullPn}}}

Input: "I see twelve Charmin ultra soft"
→ {"kind":"database_entry","fields":{"${qk}":12,"${bk}":"Charmin"${nullPt}${pk ? `,"${pk}":"ultra soft"` : ''}}}

Input: "brand Kirkland Signature type toilet paper count 24"
→ {"kind":"database_entry","fields":{"${qk}":24,"${bk}":"Kirkland Signature","${tk}":"toilet paper"${nullPn}}}

Critical rules:
- A spoken number immediately before or after a product phrase is ALWAYS "${qk}", even if "${qk}" appears last in the schema.
- NEVER put a number in "${bk}" or "${tk}".
- Spoken numbers: ${spokeNumMap}.
`;
      } else if (quantityDef) {
        fewShot = `\nCritical rule: A spoken number referring to a count is ALWAYS "${quantityDef.key}". Spoken numbers: ${spokeNumMap}.\n`;
      }

      return `Return ONLY one JSON object (no markdown, no prose).
${fewShot}
Schema — use these exact key names:
{"kind":"database_entry","fields":{
${fieldLines.join(',\n')}
}}
Use JSON numbers for integer/real fields. Use null when a value is truly unknown.`;
    }
    default:
      return '{"kind":"notes","body":"string"}';
  }
}

function schemaIdFromTemplate(template: Template): string | null {
  if (template.type !== 'database_entry') return null;
  if (template.id.startsWith('master-')) return template.id.slice('master-'.length);
  return null;
}

export type VoiceParserContextValue = {
  parseVoice: (uri: string, template: Template) => Promise<ParseResult | null>;
  parseTranscript: (transcript: string, template: Template) => Promise<ParseResult | null>;
  isReady: boolean;
  isLoading: boolean;
  downloadProgress: number;
  error: string | null;
};

const VoiceParserContext = createContext<VoiceParserContextValue | null>(null);

export function VoiceParserProvider({ children }: { children: React.ReactNode }) {
  const {
    complete,
    init,
    download,
    isDownloaded,
    isDownloading,
    downloadProgress,
    isInitializing,
    error: lmError,
  } = useCactusLM({
    model: MODEL_ID,
    cacheIndex: false,
    options: { pro: false },
  });

  const [lmInitialized, setLmInitialized] = useState(false);

  useEffect(() => {
    if (isDownloaded || isDownloading) return;
    void download().catch(() => {});
  }, [isDownloaded, isDownloading, download]);

  useEffect(() => {
    let cancelled = false;
    if (!isDownloaded) return;
    (async () => {
      try {
        await init();
        if (!cancelled) setLmInitialized(true);
      } catch {
        if (!cancelled) setLmInitialized(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDownloaded, init]);

  const parseTranscript = useCallback(
    async (transcript: string, template: Template): Promise<ParseResult | null> => {
      const trimmed = transcript.trim();
      if (!trimmed) return null;
      const schemaId = schemaIdFromTemplate(template);
      const learned = getLearnedSchemaSnapshot(schemaId);
      const learnedBlock = learned
        ? `\nUse this historical extraction memory to improve recall on unstructured speech:\n${learned.promptSummary}\n`
        : '';

      const system = `You convert voice transcripts into structured JSON for an app template.
${jsonSchemaPrompt(template)}
${learnedBlock}
Rules: Output ONLY the JSON object. No markdown, no commentary.`;

      const messages = [
        { role: 'system' as const, content: system },
        {
          role: 'user' as const,
          content: `Transcript:\n${trimmed}`,
        },
      ];

      try {
        const result = await complete({
          messages,
          options: { temperature: 0, maxTokens: 1024 },
        });
        if (!result.success) {
          const fb = applyMasterEnrichmentIfNeeded(
            template,
            trimmed,
            fallbackPayload(template, trimmed),
          );
          return {
            record: {
              templateId: template.id,
              templateName: template.name,
              payload: fb,
              rawTranscript: trimmed,
            },
            confidence: 0.22,
            latencyMs: result.totalTimeMs ?? 0,
            issues: [],
          };
        }
        const jsonText = extractJsonObject(result.response);
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          const fb = applyMasterEnrichmentIfNeeded(template, trimmed, fallbackPayload(template, trimmed));
          return {
            record: {
              templateId: template.id,
              templateName: template.name,
              payload: fb,
              rawTranscript: trimmed,
            },
            confidence: 0.4,
            latencyMs: 0,
            issues: [],
          };
        }

        const v = validateParsedPayload(template, parsed);
        let payload = v.ok ? v.payload : fallbackPayload(template, trimmed);
        const issues: ParseIssue[] = [];

        // Run the normalization layer for database_entry templates.
        if (v.ok && v.payload.kind === 'database_entry' && template.type === 'database_entry') {
          const rawFields = v.payload.fields as Record<string, unknown>;
          const { fields: normalizedFields, issues: normIssues } = normalizeLmResult(
            template,
            rawFields,
            trimmed,
          );
          issues.push(...normIssues);
          payload = { kind: 'database_entry', fields: normalizedFields };
        }

        // Enrichment fills remaining null fields; normalization handled the primary cases.
        payload = applyMasterEnrichmentIfNeeded(template, trimmed, payload);

        const modelConf =
          typeof result.confidence === 'number' && !Number.isNaN(result.confidence)
            ? result.confidence
            : v.ok
              ? 0.88
              : 0.45;

        if (modelConf < 0.7) {
          issues.push({
            field: '',
            severity: 'warning',
            code: 'low_confidence',
            message: `Model confidence ${Math.round(modelConf * 100)}% — review carefully`,
          });
        }

        return {
          record: {
            templateId: template.id,
            templateName: template.name,
            payload,
            rawTranscript: trimmed,
          },
          confidence: modelConf,
          latencyMs: result.totalTimeMs ?? 0,
          issues,
        };
      } catch {
        const fb = applyMasterEnrichmentIfNeeded(template, trimmed, fallbackPayload(template, trimmed));
        return {
          record: {
            templateId: template.id,
            templateName: template.name,
            payload: fb,
            rawTranscript: trimmed,
          },
          confidence: 0.35,
          latencyMs: 0,
          issues: [],
        };
      }
    },
    [complete],
  );

  const parseVoice = useCallback(
    async (uri: string, template: Template): Promise<ParseResult | null> => {
      const isIos = Platform.OS === 'ios';
      const filename = isIos ? 'capture.wav' : 'capture.m4a';
      const mime = isIos ? 'audio/wav' : 'audio/mp4';
      try {
        const { transcript } = await transcribeAudioFile(uri, filename, mime);
        return parseTranscript(transcript, template);
      } catch {
        return null;
      }
    },
    [parseTranscript],
  );

  const isLoading = isDownloading || !isDownloaded || isInitializing || !lmInitialized;
  const isReady = isDownloaded && lmInitialized && !isInitializing && !isDownloading;

  const value = useMemo<VoiceParserContextValue>(
    () => ({
      parseVoice,
      parseTranscript,
      isReady,
      isLoading,
      downloadProgress,
      error: lmError,
    }),
    [
      parseVoice,
      parseTranscript,
      isReady,
      isLoading,
      downloadProgress,
      lmError,
    ],
  );

  return (
    <VoiceParserContext.Provider value={value}>{children}</VoiceParserContext.Provider>
  );
}

export function useVoiceParser(): VoiceParserContextValue {
  const ctx = useContext(VoiceParserContext);
  if (!ctx) {
    throw new Error('useVoiceParser must be used within VoiceParserProvider');
  }
  return ctx;
}
