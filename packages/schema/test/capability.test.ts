import { describe, expect, it } from 'vitest';
import { capabilitySchema, PROVIDER_SCHEMA_VERSION } from '../src/index.js';

describe('capabilitySchema', () => {
  const minimal = {
    input: ['text'],
    output: ['text'],
    contextChars: 100_000,
    maxOutputChars: 32_000,
  };

  it('applies honest defaults to everything not stated', () => {
    const cap = capabilitySchema.parse(minimal);

    // Nothing is claimed until it is declared or measured.
    expect(cap.toolCalling).toBe('unmeasured');
    expect(cap.structuredOutput).toBe('unmeasured');
    expect(cap.streaming).toBe(false);
    expect(cap.vision).toBe(false);
    expect(cap.toolCallAccuracy).toBeUndefined();
  });

  it('rejects a modality that does not exist', () => {
    const result = capabilitySchema.safeParse({ ...minimal, input: ['hologram'] });
    expect(result.success).toBe(false);
  });

  it('requires an explicit, positive context budget', () => {
    expect(capabilitySchema.safeParse({ ...minimal, contextChars: 0 }).success).toBe(false);
    const { contextChars: _omitted, ...withoutContext } = minimal;
    expect(capabilitySchema.safeParse(withoutContext).success).toBe(false);
  });

  it('keeps a measured tool-call accuracy when supplied', () => {
    const cap = capabilitySchema.parse({
      ...minimal,
      toolCalling: 'text-emulated',
      toolCallAccuracy: { value: 0.97, samples: 200, measuredAt: '2026-08-27' },
    });
    expect(cap.toolCallAccuracy?.value).toBeCloseTo(0.97);
  });

  it('rejects an accuracy outside 0..1', () => {
    const result = capabilitySchema.safeParse({
      ...minimal,
      toolCallAccuracy: { value: 1.5, samples: 10, measuredAt: '2026-08-27' },
    });
    expect(result.success).toBe(false);
  });
});

describe('PROVIDER_SCHEMA_VERSION', () => {
  it('is a stable public contract', () => {
    expect(PROVIDER_SCHEMA_VERSION).toBe(1);
  });
});

describe('emulationSupport', () => {
  const minimal = {
    input: ['text'],
    output: ['text'],
    contextChars: 100_000,
    maxOutputChars: 32_000,
  };

  it('accepts native tool calling, for app-backend channels (ADR-0006)', () => {
    const cap = capabilitySchema.parse({ ...minimal, toolCalling: 'native' });
    expect(cap.toolCalling).toBe('native');
  });

  it('still rejects a value that means nothing', () => {
    expect(capabilitySchema.safeParse({ ...minimal, toolCalling: 'probably' }).success).toBe(
      false,
    );
  });
});
