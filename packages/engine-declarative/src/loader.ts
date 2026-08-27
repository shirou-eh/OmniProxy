import { providerDeclarationSchema, type ProviderDeclaration } from '@omniproxy/schema';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import { TransformRegistry } from './transforms.js';

/**
 * Loading and validating a `provider.yaml`.
 *
 * The error messages here are the product. A declaration is what a person edits at
 * 3am when a provider breaks, and the difference between "invalid input" and
 * "flow.send.stream.map.text: must be a JSONPath expression starting with $" is the
 * difference between a five-minute fix and an evening.
 */

export class DeclarationError extends Error {
  override readonly name = 'DeclarationError';
  constructor(
    message: string,
    readonly userAction: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export interface LoadOptions {
  /** Where it came from, for error messages. */
  source?: string;
  /** Transforms available; a declaration naming a missing one is rejected up front. */
  transforms?: TransformRegistry;
}

export function parseDeclaration(text: string, options: LoadOptions = {}): ProviderDeclaration {
  const source = options.source ?? 'provider.yaml';

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const line = error.linePos?.[0]?.line;
      throw new DeclarationError(
        `${source} is not valid YAML${line ? ` (line ${line})` : ''}: ${error.message}`,
        'Fix the YAML syntax. Indentation and a stray tab are the usual culprits.',
      );
    }
    throw error;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DeclarationError(
      `${source} is empty or is not a mapping`,
      'A declaration is a YAML mapping starting with schemaVersion: 1.',
    );
  }

  const result = providerDeclarationSchema.safeParse(raw);
  if (!result.success) {
    const issues = formatIssues(result.error);
    throw new DeclarationError(
      `${source} is not a valid provider declaration:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
      'Check docs/omniproxy/02-provider-yaml.md. Unknown keys are rejected on purpose: a typo that is silently ignored is a bug you find much later.',
      issues,
    );
  }

  const declaration = result.data;

  const transforms = options.transforms ?? new TransformRegistry();
  const missing = Object.entries(declaration.vars)
    .filter(([, spec]) => !transforms.has(spec.transform))
    .map(([name, spec]) => `vars.${name} uses unknown transform "${spec.transform}"`);
  if (missing.length > 0) {
    throw new DeclarationError(
      `${source} names transforms that do not exist:\n${missing.map((m) => `  - ${m}`).join('\n')}`,
      `Available transforms: ${transforms.names().join(', ')}. A declaration can only name code that exists (ADR-0002).`,
      missing,
    );
  }

  return declaration;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/** Validation that reports everything instead of throwing on the first problem. */
export interface ValidationReport {
  ok: boolean;
  declaration?: ProviderDeclaration;
  errors: string[];
  warnings: string[];
}

export function validateDeclaration(text: string, options: LoadOptions = {}): ValidationReport {
  try {
    const declaration = parseDeclaration(text, options);
    return { ok: true, declaration, errors: [], warnings: collectWarnings(declaration) };
  } catch (error) {
    if (error instanceof DeclarationError) {
      return { ok: false, errors: error.issues.length > 0 ? error.issues : [error.message], warnings: [] };
    }
    throw error;
  }
}

/**
 * Things that are valid but probably wrong. Warnings, never refusals — the author
 * knows their provider better than this list does (hackability charter, X-6).
 */
function collectWarnings(declaration: ProviderDeclaration): string[] {
  const warnings: string[] = [];

  if (declaration.status === 'stable' && !declaration.capture?.bundle) {
    warnings.push(
      'status is "stable" but no capture bundle is recorded. A provider nobody has ' +
        'recorded cannot be verified, and cannot honestly be called stable.',
    );
  }

  if (declaration.models.length === 0) {
    warnings.push('no models declared: nothing can be routed to this provider.');
  }

  if (!declaration.probe) {
    warnings.push(
      'no probe block: this provider has no canary, so a breakage will be noticed by a ' +
        'user rather than by the scheduler.',
    );
  }

  if (!declaration.context?.measured) {
    warnings.push(
      'context.measured is missing: the context budget is a guess until it is measured.',
    );
  }

  if (declaration.flow.send?.stream?.format === 'json-patch' && !declaration.flow.send.stream.patch) {
    warnings.push(
      'json-patch framing without a patch block falls back to the DeepSeek routes. ' +
        'State them explicitly if this provider is not DeepSeek.',
    );
  }

  for (const channel of declaration.channels) {
    if (channel.kind === 'local-process') {
      warnings.push(
        `channel "${channel.id}" starts an external process. It will not run until the ` +
          'user trusts this provider explicitly (ADR-0006).',
      );
    }
  }

  return warnings;
}
