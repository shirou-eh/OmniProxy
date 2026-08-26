import { z } from 'zod';

/** Everything OmniProxy can carry in or out of a provider. */
export const modalitySchema = z.enum([
  'text',
  'image',
  'video',
  'audio',
  'music',
  'speech',
  '3d',
]);

export type Modality = z.infer<typeof modalitySchema>;

/**
 * Web channels have no native tool calling or structured output anywhere — the best
 * any provider can do is emulate it in text. `unmeasured` is the honest default:
 * we do not claim a provider can do it until the success rate has been measured on a
 * live account. See docs/omniproxy/00-risks.md, R-5.
 */
export const emulationSupportSchema = z.enum(['text-emulated', 'none', 'unmeasured']);

export type EmulationSupport = z.infer<typeof emulationSupportSchema>;
