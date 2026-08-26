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
 *
 * `native` exists for the `app-backend` channel class (ADR-0006): a desktop
 * application's backend can genuinely speak tool calls, unlike a web chat. No
 * provider claims it yet — the value is in the enum because this schema is a public
 * contract, and adding a value later would be a breaking change for every
 * user-authored module.
 */
export const emulationSupportSchema = z.enum([
  'native',
  'text-emulated',
  'none',
  'unmeasured',
]);

export type EmulationSupport = z.infer<typeof emulationSupportSchema>;
