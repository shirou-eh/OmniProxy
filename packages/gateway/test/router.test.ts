import type { ProviderDeclaration } from '@omniproxy/schema';
import { describe, expect, it } from 'vitest';
import { listModelIds, resolveRoute, RoutingError } from '../src/router.js';

/**
 * Routing is where a wrong answer looks most like a right one: a request served by a
 * provider the caller did not choose returns a perfectly well-formed completion from
 * the wrong model. So the interesting cases here are all about refusing to guess.
 */

function provider(id: string, ...aliases: string[]): ProviderDeclaration {
  // The router reads an id and a list of aliases; a full declaration would add noise
  // without adding coverage.
  return { id, models: aliases.map((alias) => ({ alias })) } as unknown as ProviderDeclaration;
}

const deepseek = provider('deepseek-web', 'deepseek-chat', 'deepseek-reasoner');
const other = provider('qwen-web', 'qwen-max', 'default');
const clashing = provider('kimi-web', 'default');

describe('resolveRoute', () => {
  it('finds a provider by a short alias', () => {
    const route = resolveRoute([deepseek, other], 'deepseek-reasoner');
    expect(route.provider.id).toBe('deepseek-web');
    expect(route.alias).toBe('deepseek-reasoner');
  });

  it('finds a provider by a qualified name', () => {
    const route = resolveRoute([deepseek, other], 'qwen-web/qwen-max');
    expect(route.provider.id).toBe('qwen-web');
    expect(route.alias).toBe('qwen-max');
  });

  it('refuses an ambiguous short alias instead of picking one', () => {
    // Everybody calls their model `default`. Answering with whichever provider happens
    // to be first in the list is a wrong answer that looks right.
    const failure = refusal(() => resolveRoute([other, clashing], 'default'));
    expect(failure.status).toBe(409);
    expect(failure.message).toMatch(/2 providers/);
    expect(failure.userAction).toContain('qwen-web/default');
    expect(failure.userAction).toContain('kimi-web/default');
  });

  it('serves an ambiguous alias once it is qualified', () => {
    expect(resolveRoute([other, clashing], 'kimi-web/default').provider.id).toBe('kimi-web');
  });

  it('lists what is available when the model is unknown', () => {
    const failure = refusal(() => resolveRoute([deepseek], 'gpt-4o'));
    expect(failure.status).toBe(404);
    expect(failure.userAction).toContain('deepseek-chat');
  });

  it('says so when no providers are loaded at all', () => {
    const failure = refusal(() => resolveRoute([], 'anything'));
    expect(failure.userAction).toMatch(/no providers are loaded/);
  });

  it('names the loaded providers when the qualifier is wrong', () => {
    const failure = refusal(() => resolveRoute([deepseek], 'openai/gpt-4o'));
    expect(failure.message).toMatch(/no provider "openai"/);
    expect(failure.userAction).toContain('deepseek-web');
  });

  it('lists the provider models when the qualifier is right and the alias is not', () => {
    const failure = refusal(() => resolveRoute([deepseek], 'deepseek-web/deepseek-v9'));
    expect(failure.message).toMatch(/no model "deepseek-v9"/);
    expect(failure.userAction).toContain('deepseek-chat, deepseek-reasoner');
  });

  it('reports a provider that declares no models', () => {
    const failure = refusal(() => resolveRoute([provider('empty')], 'empty/anything'));
    expect(failure.userAction).toContain('(none)');
  });

  it('treats a leading slash as a short name, not a qualifier', () => {
    // "/foo" has an empty provider id. Reading it as a qualified name would look for a
    // provider called "", which no one has; reading it as an alias fails honestly.
    const failure = refusal(() => resolveRoute([deepseek], '/deepseek-chat'));
    expect(failure.message).toMatch(/no model "\/deepseek-chat"/);
  });

  it('keeps everything after the first slash as the alias', () => {
    const nested = provider('p', 'a/b');
    expect(resolveRoute([nested], 'p/a/b').alias).toBe('a/b');
  });
});

describe('listModelIds', () => {
  it('offers every alias qualified, and the unambiguous ones bare', () => {
    expect(listModelIds([deepseek, other])).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-web/deepseek-chat',
      'deepseek-web/deepseek-reasoner',
      'default',
      'qwen-max',
      'qwen-web/default',
      'qwen-web/qwen-max',
    ]);
  });

  it('withholds a bare name that would be refused if used', () => {
    // Listing a name and then rejecting it is the worst of both: the caller has every
    // reason to believe it works.
    const ids = listModelIds([other, clashing]);
    expect(ids).not.toContain('default');
    expect(ids).toContain('qwen-web/default');
    expect(ids).toContain('kimi-web/default');

    for (const id of ids) expect(() => resolveRoute([other, clashing], id)).not.toThrow();
  });

  it('is empty when nothing is loaded', () => {
    expect(listModelIds([])).toEqual([]);
  });

  it('does not repeat, or withhold, an alias a provider declares twice', () => {
    // A declaration that lists the same alias twice is untidy. Reading it as a clash
    // and withholding the bare name would turn that into a puzzle for the caller.
    const twice = provider('p', 'a', 'a');
    expect(listModelIds([twice])).toEqual(['a', 'p/a']);
  });
});

function refusal(fn: () => unknown): RoutingError {
  try {
    fn();
  } catch (error) {
    if (error instanceof RoutingError) return error;
    throw error;
  }
  throw new Error('expected the route to be refused, and it resolved');
}
