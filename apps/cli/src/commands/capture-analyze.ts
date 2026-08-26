import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeBundle, diffCaptures, type AnalysisResult, type CaptureDiff } from '@omniproxy/capture';
import { captureBundleSchema, type CaptureBundle } from '@omniproxy/schema';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../io.js';

export const CAPTURE_ANALYZE_USAGE = `omniproxy capture analyze <bundle.json> [--compare <other.json>]

Reads a capture and works out what each call does, which ones are noise, and how
values flow from one response into the next request.

Every classification comes with the reason that produced it. They are hints for you,
not verdicts — look at anything that matters before trusting it.

Options:
  --compare <file>  A second capture of the SAME scenario. Fields that differ between
                    the two runs are the ones a declaration has to template. Without
                    it, the analysis cannot tell a constant from a variable.
  --json            Machine-readable output.
  -h, --help        Show this help.`;

export async function runCaptureAnalyze(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        compare: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    io.err(CAPTURE_ANALYZE_USAGE);
    return EXIT_USAGE;
  }

  if (parsed.values.help) {
    io.out(CAPTURE_ANALYZE_USAGE);
    return EXIT_OK;
  }

  const file = parsed.positionals[0];
  if (!file) {
    io.err('omniproxy: missing the bundle to analyze');
    io.err(CAPTURE_ANALYZE_USAGE);
    return EXIT_USAGE;
  }

  const bundle = await loadBundle(file, io);
  if (!bundle) return EXIT_FAILURE;

  const analysis = analyzeBundle(bundle);

  let diff: CaptureDiff | undefined;
  if (parsed.values.compare !== undefined) {
    const other = await loadBundle(parsed.values.compare, io);
    if (!other) return EXIT_FAILURE;
    diff = diffCaptures(bundle, other);
  }

  if (parsed.values.json) {
    io.out(JSON.stringify({ flow: analysis.flow, links: analysis.links, warnings: analysis.warnings, diff }, null, 2));
    return EXIT_OK;
  }

  report(analysis, diff, io);
  return EXIT_OK;
}

async function loadBundle(file: string, io: CliIo): Promise<CaptureBundle | undefined> {
  const path = isAbsolute(file) ? file : resolve(io.cwd, file);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    io.err(`omniproxy: cannot read ${path}: ${(error as Error).message}`);
    return undefined;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    io.err(`omniproxy: ${path} is not valid JSON: ${(error as Error).message}`);
    return undefined;
  }

  const result = captureBundleSchema.safeParse(json);
  if (!result.success) {
    io.err(`omniproxy: ${path} is not a capture bundle.`);
    io.err('Import a HAR first: omniproxy capture import <file.har> --provider <id> --scenario <name>');
    return undefined;
  }
  return result.data;
}

function report(analysis: AnalysisResult, diff: CaptureDiff | undefined, io: CliIo): void {
  const volatileByIndex = new Map(
    (diff?.entries ?? []).map((entry) => [entry.index, entry.volatileFields]),
  );

  io.out(`Flow — ${analysis.flow.length} meaningful call(s), ${analysis.noise.length} set aside`);
  io.out('');

  for (const step of analysis.flow) {
    io.out(`  [${step.index}] ${step.classification.toUpperCase().padEnd(8)} ${step.method} ${shortUrl(step.url)}  → ${step.status}`);
    for (const reason of step.reasons) io.out(`      why: ${reason}`);
    for (const link of step.consumes) {
      io.out(`      uses: ${link.sample} from [${link.from}] ${link.sourcePath} → ${link.targetPath}`);
    }
    const volatile = volatileByIndex.get(step.index) ?? [];
    for (const field of volatile) io.out(`      varies: ${field}`);
    io.out('');
  }

  if (analysis.noise.length > 0) {
    io.out('Set aside (kept in the bundle, not deleted):');
    for (const step of analysis.noise) {
      io.out(`  [${step.index}] ${step.classification} — ${shortUrl(step.url)} (${step.reasons[0] ?? ''})`);
    }
    io.out('');
  }

  if (diff) {
    const totalVolatile = diff.entries.reduce((sum, entry) => sum + entry.volatileFields.length, 0);
    io.out(`Compared against the second capture: ${totalVolatile} field(s) vary between runs.`);
    if (diff.unmatchedInA.length > 0 || diff.unmatchedInB.length > 0) {
      io.out(`  unmatched: ${diff.unmatchedInA.length} in the first, ${diff.unmatchedInB.length} in the second`);
    }
    io.out('');
  } else {
    io.out('No second capture supplied, so nothing is known about what varies between runs.');
    io.out('Record the same scenario again and pass --compare: that is what separates a');
    io.out('constant from a variable, and a draft cannot be templated without it.');
    io.out('');
  }

  for (const warning of analysis.warnings) io.err(`warning: ${warning}`);
  for (const warning of diff?.warnings ?? []) io.err(`warning: ${warning}`);
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.search ? '?…' : ''}`;
  } catch {
    return url;
  }
}
