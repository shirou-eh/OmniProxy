/**
 * @omniproxy/engine-declarative — executing provider.yaml.
 *
 * ADR-0002 in code: a declaration is data, transforms are named code, and anything
 * that needs neither is expressed in YAML that can be fixed without a rebuild.
 */

export { parseDeclaration, validateDeclaration, DeclarationError } from './loader.js';
export type { LoadOptions, ValidationReport } from './loader.js';

export { executeFlow, buildRequest, pickChannel, resolveModel, matchErrorRule, DeclarationExecutionError } from './executor.js';
export type { ExecuteOptions, EngineRequest } from './executor.js';

export { createFramer } from './framing.js';
export type { Framer, FrameEvent } from './framing.js';

export { renderTemplate, renderValue, TemplateError } from './template.js';
export type { TemplateContext, RenderResult } from './template.js';

export { parseJsonPath, queryJsonPath, selectJsonPath, JsonPathError } from './jsonpath.js';
export type { JsonPathSegment } from './jsonpath.js';

export {
  TransformRegistry,
  TransformError,
  builtinTransforms,
  defaultTransformContext,
  solveDeepSeekPow,
  clearWasmCache,
} from './transforms.js';
export type { Transform, TransformContext, WasmPowInstance, DeepSeekChallenge } from './transforms.js';

export {
  discoverProviders,
  loadProvider,
  loadDeclarationFile,
  providerSearchPath,
} from './discovery.js';
export type { DiscoveryOptions, FoundProvider } from './discovery.js';

/** Re-exported so a consumer needs one import, not two, to hold a declaration. */
export type { ProviderDeclaration } from '@omniproxy/schema';

export { memoryStateStore } from './ports.js';
export type { HttpClient, HttpRequest, HttpResponse, HttpStreamResponse, StateStore } from './ports.js';
