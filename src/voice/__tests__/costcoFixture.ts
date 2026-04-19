/**
 * Costco inventory parser regression fixture.
 *
 * Not imported by production code. Use this file to manually verify normalizeLmResult
 * behaviour by calling normalizeLmResult(costcoTemplate, <rawLmOutput>, <transcript>)
 * and asserting the expected fields and issues.
 *
 * Run manually: import this file in a dev screen, call runCostcoFixtures(), log the output.
 */

import { normalizeLmResult } from '../parserNormalization';
import type { Template } from '../../core/schemas';

// The Costco inventory template as the app sees it after masterSchemaToTemplate().
export const costcoTemplate: Template = {
  id: 'master-costco_inventory',
  name: 'Costco inventory',
  type: 'database_entry',
  schemaDefinition: [
    {
      key: 'brand',
      label: 'Brand',
      valueType: 'text',
      parser: { semanticRole: 'brand', aliases: ['manufacturer', 'maker', 'Brand:'] },
    },
    {
      key: 'product_type',
      label: 'Product type',
      valueType: 'text',
      parser: { semanticRole: 'product_type', aliases: ['category', 'type', 'Product type:'] },
    },
    {
      key: 'product_name',
      label: 'Product name',
      valueType: 'text',
      parser: { semanticRole: 'product_name', aliases: ['sku', 'called', 'named', 'Product name:'] },
    },
    {
      key: 'quantity',
      label: 'Quantity (units)',
      valueType: 'integer',
      parser: { semanticRole: 'quantity', parsePriority: 0, aliases: ['count', 'qty', 'units', 'how many', 'Quantity:'] },
    },
  ],
};

// A permuted schema variant with quantity listed first — normalization output order should match original template order.
export const costcoPermutedTemplate: Template = {
  ...costcoTemplate,
  id: 'master-costco_inventory_permuted',
  schemaDefinition: [
    costcoTemplate.schemaDefinition[3], // quantity first
    costcoTemplate.schemaDefinition[0], // brand
    costcoTemplate.schemaDefinition[1], // product_type
    costcoTemplate.schemaDefinition[2], // product_name
  ],
};

export type FixtureCase = {
  description: string;
  transcript: string;
  rawLmOutput: Record<string, unknown>;
  expected: { brand: string | null; product_type: string | null; product_name: string | null; quantity: number | null };
  expectIssues: boolean;
};

export const FIXTURE_CASES: FixtureCase[] = [
  {
    description: 'Clean parse — LM returns correct fields',
    transcript: 'three Kirkland Signature chickens',
    rawLmOutput: { brand: 'Kirkland Signature', product_type: 'chickens', product_name: null, quantity: 3 },
    expected: { brand: 'Kirkland Signature', product_type: 'chickens', product_name: null, quantity: 3 },
    expectIssues: false,
  },
  {
    description: 'Spoken number coercion — quantity as word',
    transcript: 'twelve Charmin ultra soft',
    rawLmOutput: { brand: 'Charmin', product_type: null, product_name: 'ultra soft', quantity: 'twelve' },
    expected: { brand: 'Charmin', product_type: null, product_name: 'ultra soft', quantity: 12 },
    expectIssues: true, // semantic_repair_applied for word coercion
  },
  {
    description: 'Slot-swap repair — number landed in brand field',
    transcript: 'three Kirkland Signature chickens',
    rawLmOutput: { brand: 3, product_type: 'Kirkland Signature', product_name: null, quantity: 'chickens' },
    expected: { brand: null, product_type: null, product_name: null, quantity: 3 },
    // brand=3 → moved to quantity; product_type="Kirkland Signature" stays; quantity="chickens" → type_mismatch error
    expectIssues: true,
  },
  {
    description: 'Label keys — LM returns label names instead of field keys',
    transcript: 'brand Kirkland Signature type toilet paper quantity 5',
    rawLmOutput: { 'Brand': 'Kirkland Signature', 'Product type': 'toilet paper', 'Product name': null, 'Quantity (units)': 5 },
    expected: { brand: 'Kirkland Signature', product_type: 'toilet paper', product_name: null, quantity: 5 },
    expectIssues: true, // semantic_repair_applied for each label→key remap
  },
  {
    description: 'Alias keys — LM uses aliases like count and manufacturer',
    transcript: 'count 24 manufacturer Kirkland type toilet paper',
    rawLmOutput: { count: 24, manufacturer: 'Kirkland', type: 'toilet paper' },
    expected: { brand: 'Kirkland', product_type: 'toilet paper', product_name: null, quantity: 24 },
    expectIssues: true, // semantic_repair_applied for alias remaps
  },
  {
    description: 'Unknown fields dropped',
    transcript: 'three Kirkland chickens extra_field something',
    rawLmOutput: { brand: 'Kirkland', product_type: 'chickens', product_name: null, quantity: 3, extra_field: 'something' },
    expected: { brand: 'Kirkland', product_type: 'chickens', product_name: null, quantity: 3 },
    expectIssues: true, // unknown_field warning for extra_field
  },
];

/**
 * Run all fixture cases and return pass/fail results.
 * Call this from a dev screen to verify normalization behaviour end-to-end.
 */
export function runCostcoFixtures(): { passed: number; failed: number; results: Array<{ name: string; passed: boolean; detail?: string }> } {
  let passed = 0;
  let failed = 0;
  const results: Array<{ name: string; passed: boolean; detail?: string }> = [];

  for (const fixture of FIXTURE_CASES) {
    const { fields, issues } = normalizeLmResult(costcoTemplate, fixture.rawLmOutput, fixture.transcript);
    const exp = fixture.expected;

    const matchesBrand = fields.brand === exp.brand;
    const matchesPt = fields.product_type === exp.product_type;
    const matchesPn = fields.product_name === exp.product_name;
    const matchesQty = fields.quantity === exp.quantity;
    const hasIssues = issues.length > 0;
    const issuesOk = fixture.expectIssues ? hasIssues : !hasIssues;

    const ok = matchesBrand && matchesPt && matchesPn && matchesQty && issuesOk;

    if (ok) {
      passed++;
      results.push({ name: fixture.description, passed: true });
    } else {
      failed++;
      const detail = [
        !matchesBrand && `brand: expected "${exp.brand}" got "${fields.brand}"`,
        !matchesPt && `product_type: expected "${exp.product_type}" got "${fields.product_type}"`,
        !matchesPn && `product_name: expected "${exp.product_name}" got "${fields.product_name}"`,
        !matchesQty && `quantity: expected ${exp.quantity} got ${fields.quantity}`,
        !issuesOk && (fixture.expectIssues ? 'expected issues but got none' : `unexpected issues: ${issues.map(i => i.message).join('; ')}`),
      ].filter(Boolean).join(' | ');
      results.push({ name: fixture.description, passed: false, detail });
    }
  }

  return { passed, failed, results };
}
