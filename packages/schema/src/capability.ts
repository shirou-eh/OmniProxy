import { z } from 'zod';
import { emulationSupportSchema, modalitySchema } from './modality.js';

/**
 * What a model can actually do, as measured — not as advertised.
 *
 * Two deliberate departures from a conventional capability model:
 *  - there is no cost hint. Web channels have no per-token price; the scarce resource
 *    is the account's daily quota, so `quota` is what the scheduler optimises.
 *  - `contextChars` is an empirical measurement, not a marketing number. A provider
 *    claiming a million tokens routinely truncates far earlier.
 */
export const quotaSchema = z.object({
  unit: z.enum(['message', 'generation', 'credit']),
  perDay: z.number().int().positive().optional(),
  perHour: z.number().int().positive().optional(),
});

export const editingSchema = z.object({
  inpaint: z.boolean().default(false),
  outpaint: z.boolean().default(false),
  upscale: z.boolean().default(false),
  refine: z.boolean().default(false),
});

export const refsSchema = z.object({
  image: z.boolean().default(false),
  video: z.boolean().default(false),
  audio: z.boolean().default(false),
  character: z.boolean().default(false),
});

/** Measured quality of the text-emulated tool protocol. Absent means never measured. */
export const toolCallAccuracySchema = z.object({
  value: z.number().min(0).max(1),
  samples: z.number().int().positive(),
  measuredAt: z.iso.date(),
});

export const capabilitySchema = z.object({
  input: z.array(modalitySchema).min(1),
  output: z.array(modalitySchema).min(1),

  streaming: z.boolean().default(false),
  /** Requires the job model: video, music, 3d. */
  async: z.boolean().default(false),

  toolCalling: emulationSupportSchema.default('unmeasured'),
  structuredOutput: emulationSupportSchema.default('unmeasured'),

  reasoning: z.boolean().default(false),
  webSearch: z.boolean().default(false),
  vision: z.boolean().default(false),
  fileUpload: z.boolean().default(false),

  contextChars: z.number().int().positive(),
  maxOutputChars: z.number().int().positive(),

  editing: editingSchema.optional(),
  refs: refsSchema.optional(),
  quota: quotaSchema.optional(),
  toolCallAccuracy: toolCallAccuracySchema.optional(),
});

export type Capability = z.infer<typeof capabilitySchema>;
export type Quota = z.infer<typeof quotaSchema>;
