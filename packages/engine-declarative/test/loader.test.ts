import { describe, expect, it } from 'vitest';
import { DeclarationError, parseDeclaration, validateDeclaration } from '../src/loader.js';
import { TransformRegistry } from '../src/transforms.js';
import { deepseekYaml, minimalYaml } from './fixtures.js';

describe('parseDeclaration', () => {
  it('loads a realistic declaration and applies the documented defaults', () => {
    const declaration = parseDeclaration(deepseekYaml);

    expect(declaration.id).toBe('deepseek-web');
    expect(declaration.channels[0]!.fingerprint.profile).toBe('chrome-131');
    expect(declaration.channels[0]!.http2).toBe(true);
    expect(declaration.channels[0]!.concurrency).toBe(1);
    expect(declaration.flow.prepare).toHaveLength(1);
    expect(declaration.flow.send!.request.method).toBe('POST');
    expect(declaration.errors[0]!.retryable).toBe('no');
    expect(declaration.errors[1]!.retryable).toBe('other-account');
    expect(declaration.models.map((m) => m.alias)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('loads the minimal declaration', () => {
    const declaration = parseDeclaration(minimalYaml);
    expect(declaration.vars).toEqual({});
    expect(declaration.flow.prepare).toEqual([]);
    expect(declaration.allowedHosts).toEqual([]);
  });

  it('reports the YAML line when the file does not parse', () => {
    const error = capture(() => parseDeclaration('id: a\n\tbad: indent', { source: 'x.yaml' }));
    expect(error).toBeInstanceOf(DeclarationError);
    expect(error.message).toMatch(/x\.yaml is not valid YAML/);
    expect(error.userAction).toMatch(/Indentation/);
  });

  it('rejects an empty file, and says what a declaration looks like', () => {
    expect(capture(() => parseDeclaration('')).message).toMatch(/empty or is not a mapping/);
    expect(capture(() => parseDeclaration('- a\n- b')).message).toMatch(/not a mapping/);
  });

  it('names the offending field, with its path', () => {
    const error = capture(() => parseDeclaration('schemaVersion: 1\nid: Bad Id\nstatus: stable'));
    expect(error.issues.some((issue) => issue.startsWith('id:'))).toBe(true);
    expect(error.issues.join('\n')).toMatch(/lowercase kebab-case/);
  });

  it('rejects an unknown key instead of ignoring it', () => {
    // A silently ignored typo is a bug that surfaces hours later as an empty response.
    const error = capture(() => parseDeclaration(`${minimalYaml}\nchanels: []\n`));
    expect(error.issues.join('\n')).toMatch(/chanels|Unrecognized/i);
  });

  it('enforces the cross-field rules', () => {
    const noBase = capture(() =>
      parseDeclaration('schemaVersion: 1\nid: x\nstatus: broken\nchannels:\n  - id: a\n    kind: web-http\nauth:\n  kind: none\nflow: {}\n'),
    );
    expect(noBase.issues.join('\n')).toMatch(/needs a base URL/);

    const pollWithoutSubmit = capture(() =>
      parseDeclaration(
        minimalYaml.replace(
          'models:',
          'flow2: x\nmodels:',
        ),
      ),
    );
    expect(pollWithoutSubmit).toBeInstanceOf(DeclarationError);
  });

  it('rejects a request that has neither path nor url', () => {
    const error = capture(() =>
      parseDeclaration(minimalYaml.replace('      path: /chat\n', '')),
    );
    expect(error.issues.join('\n')).toMatch(/needs either `path`/);
  });

  it('rejects a JSONPath that is not one', () => {
    const error = capture(() => parseDeclaration(minimalYaml.replace('$.delta', 'delta')));
    expect(error.issues.join('\n')).toMatch(/must be a JSONPath expression starting with \$/);
  });

  it('refuses a declaration that names a transform nobody implemented', () => {
    const error = capture(() =>
      parseDeclaration(deepseekYaml.replace('transform: deepseek-pow-v0', 'transform: magic-sign')),
    );
    expect(error.message).toMatch(/names transforms that do not exist/);
    expect(error.userAction).toMatch(/Available transforms:/);
  });

  it('accepts a declaration whose transform the user supplied themselves', () => {
    // ADR-0003: a third-party module brings its own code, and the loader must not
    // treat "not one of ours" as "not real".
    const yaml = deepseekYaml.replace('transform: deepseek-pow-v0', 'transform: magic-sign');
    const transforms = new TransformRegistry({ 'magic-sign': () => 'signed' });
    expect(parseDeclaration(yaml, { transforms }).vars['pow']!.transform).toBe('magic-sign');
  });

  it('refuses inline code wherever an author might try to smuggle it in', () => {
    // The whole safety argument of ADR-0002 rests on this: a declaration can arrive
    // from a stranger, so there must be no key anywhere that becomes executable.
    for (const attempt of [
      'vars:\n  x:\n    transform: eval\n    code: "process.exit(1)"\n',
      'flow:\n  send:\n    script: "require(\'fs\')"\n',
      'hooks:\n  beforeSend: "() => {}"\n',
    ]) {
      const error = capture(() => parseDeclaration(`${minimalYaml}\n${attempt}`));
      expect(error).toBeInstanceOf(DeclarationError);
    }
  });
});

describe('validateDeclaration', () => {
  it('reports every problem at once instead of stopping at the first', () => {
    const report = validateDeclaration('schemaVersion: 1\nid: X Y\nstatus: nope\n');
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(1);
  });

  it('returns the declaration when it is valid', () => {
    const report = validateDeclaration(deepseekYaml);
    expect(report.ok).toBe(true);
    expect(report.declaration?.id).toBe('deepseek-web');
    expect(report.errors).toEqual([]);
  });

  it('warns without refusing — the author knows their provider better than this list', () => {
    const report = validateDeclaration(minimalYaml);
    expect(report.ok).toBe(true);
    expect(report.warnings.join('\n')).toMatch(/no probe block/);
    expect(report.warnings.join('\n')).toMatch(/context\.measured is missing/);
  });

  it('warns that a stable provider with no capture cannot honestly be called stable', () => {
    const report = validateDeclaration(minimalYaml.replace('needs-capture', 'stable'));
    expect(report.ok).toBe(true);
    expect(report.warnings.join('\n')).toMatch(/cannot be verified/);
  });

  it('warns about json-patch framing with no explicit patch block', () => {
    const report = validateDeclaration(deepseekYaml);
    expect(report.warnings.join('\n')).toMatch(/falls back to the DeepSeek routes/);
  });

  it('warns that a local-process channel will not run until it is trusted', () => {
    const yaml = `
schemaVersion: 1
id: third-party
status: unverified
channels:
  - id: local
    kind: local-process
    speaks: openai
    process:
      command: node
      args: ['proxy.js']
auth:
  kind: none
flow: {}
`;
    const report = validateDeclaration(yaml);
    expect(report.ok).toBe(true);
    expect(report.warnings.join('\n')).toMatch(/until the user trusts this provider/);
    expect(report.warnings.join('\n')).toMatch(/nothing can be routed/);
  });
});

function capture(fn: () => unknown): DeclarationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DeclarationError) return error;
    throw error;
  }
  throw new Error('expected the declaration to be rejected, and it was accepted');
}
