import type { ProviderDeclaration } from '@omniproxy/schema';

/**
 * Which provider answers a request for a given model name.
 *
 * Two forms are accepted, and the difference matters:
 *
 *   `deepseek-chat`             — whichever provider declares that alias
 *   `deepseek-web/deepseek-chat` — that provider, and no other
 *
 * The qualified form exists because the short one becomes ambiguous the moment two
 * providers declare the same alias, which they will: everybody calls their model
 * `default`. When it is ambiguous the router says so and lists the qualified names,
 * rather than picking one — a request answered by a different provider than the caller
 * expected is a wrong answer that looks right.
 */

export interface Route {
  provider: ProviderDeclaration;
  /** The alias as the provider declares it. */
  alias: string;
}

export class RoutingError extends Error {
  override readonly name = 'RoutingError';
  constructor(
    message: string,
    readonly userAction: string,
    readonly status = 404,
  ) {
    super(message);
  }
}

export function resolveRoute(
  providers: readonly ProviderDeclaration[],
  model: string,
): Route {
  const separator = model.indexOf('/');

  if (separator > 0) {
    const providerId = model.slice(0, separator);
    const alias = model.slice(separator + 1);
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new RoutingError(
        `no provider "${providerId}"`,
        `Loaded providers: ${listProviders(providers)}. Run "omniproxy provider list" to see where they came from.`,
      );
    }
    if (!provider.models.some((candidate) => candidate.alias === alias)) {
      throw new RoutingError(
        `${providerId} has no model "${alias}"`,
        `It declares: ${provider.models.map((m) => m.alias).join(', ') || '(none)'}.`,
      );
    }
    return { provider, alias };
  }

  const matches = providers.filter((provider) =>
    provider.models.some((candidate) => candidate.alias === model),
  );

  if (matches.length === 1) return { provider: matches[0] as ProviderDeclaration, alias: model };

  if (matches.length === 0) {
    throw new RoutingError(
      `no model "${model}"`,
      `Available: ${listModels(providers) || '(no providers are loaded)'}.`,
    );
  }

  // Ambiguous. Picking one would answer with a provider the caller did not choose.
  throw new RoutingError(
    `"${model}" is declared by ${matches.length} providers`,
    `Name one: ${matches.map((provider) => `${provider.id}/${model}`).join(', ')}.`,
    409,
  );
}

/** The `/v1/models` listing: every alias, qualified and unqualified. */
export function listModelIds(providers: readonly ProviderDeclaration[]): string[] {
  const ids = new Set<string>();
  const seen = new Map<string, number>();

  for (const provider of providers) {
    // Counted once per provider, not once per entry: a declaration that lists the same
    // alias twice is untidy, and withholding the bare name over it would be a puzzle.
    for (const alias of new Set(provider.models.map((model) => model.alias))) {
      seen.set(alias, (seen.get(alias) ?? 0) + 1);
    }
  }

  for (const provider of providers) {
    for (const model of provider.models) {
      ids.add(`${provider.id}/${model.alias}`);
      // The short name is offered only while it is unambiguous. Listing a name that
      // would be refused if used is worse than not listing it.
      if (seen.get(model.alias) === 1) ids.add(model.alias);
    }
  }

  return [...ids].sort();
}

function listProviders(providers: readonly ProviderDeclaration[]): string {
  return providers.map((provider) => provider.id).join(', ') || '(none)';
}

function listModels(providers: readonly ProviderDeclaration[]): string {
  return listModelIds(providers).join(', ');
}
