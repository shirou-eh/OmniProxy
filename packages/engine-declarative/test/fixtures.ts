/**
 * A declaration shaped like the real DeepSeek Web one, used by the loader and
 * executor tests. It is deliberately written as YAML rather than as an object
 * literal: the thing under test is what an author types, and a schema that only ever
 * sees objects built in TypeScript would never catch a key the parser mishandles.
 */
export const deepseekYaml = `
schemaVersion: 1
id: deepseek-web
displayName: DeepSeek (web)
class: A
status: experimental
allowedHosts:
  - cdn.deepseek.test

channels:
  - id: web
    kind: web-http
    base: https://chat.deepseek.test
    fingerprint:
      profile: chrome-131
      impersonate: true
      static:
        user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)
        x-client-locale: en_US

auth:
  kind: bearer
  present:
    headers:
      authorization: Bearer {{auth.token}}

vars:
  pow:
    transform: deepseek-pow-v0
    with:
      challenge: '{{extracted.challenge}}'
      wasmUrl: https://cdn.deepseek.test/static/sha3_wasm_bg.wasm
      targetPath: /api/v0/chat/completion

flow:
  prepare:
    - request:
        method: POST
        path: /api/v0/chat/create_pow_challenge
        json:
          target_path: /api/v0/chat/completion
      extract:
        challenge: $.data.biz_data.challenge

  createSession:
    unless: '{{state.sessionId}}'
    request:
      method: POST
      path: /api/v0/chat_session/create
      json:
        character_id: null
    extract:
      sessionId: $.data.biz_data.id
    persist:
      sessionId: '{{extracted.sessionId}}'

  send:
    request:
      method: POST
      path: /api/v0/chat/completion
      headers:
        x-ds-pow-response: '{{vars.pow}}'
      json:
        chat_session_id: '{{state.sessionId}}'
        parent_message_id: '{{state.parentMessageId|null-if-empty}}'
        prompt: '{{req.prompt}}'
        thinking_enabled: false
    stream:
      format: json-patch
      doneWhen:
        data: '[DONE]'

errors:
  - match:
      status: 401
    as: auth_expired
    retryable: no
    userMessage: The DeepSeek session expired. Run omniproxy auth add deepseek-web.
  - match:
      status: 429
    as: rate_limit
    retryable: other-account
  - match:
      status: 200
      jsonPath: $.code
      equals: 40303
    as: quota_exhausted
    retryable: other-account

models:
  - alias: deepseek-chat
    native: deepseek_chat
  - alias: deepseek-reasoner
    native: deepseek_chat
    extra:
      thinking_enabled: true

context:
  strategy: flatten-to-prompt
  measured:
    contextChars: 60000
    measuredAt: 2026-08-27
`;

/** The smallest declaration that validates: useful for isolating one rule at a time. */
export const minimalYaml = `
schemaVersion: 1
id: tiny
status: needs-capture
channels:
  - id: web
    kind: web-http
    base: https://tiny.test
auth:
  kind: none
flow:
  send:
    request:
      method: POST
      path: /chat
      json:
        prompt: '{{req.prompt}}'
    stream:
      format: sse
      map:
        text: $.delta
models:
  - alias: tiny-1
    native: tiny-1
`;

/** A provider that answers in one JSON body instead of streaming. */
export const nonStreamedYaml = `
schemaVersion: 1
id: oneshot
status: needs-capture
channels:
  - id: web
    kind: web-http
    base: https://oneshot.test
auth:
  kind: none
flow:
  send:
    request:
      method: POST
      path: /generate
      json:
        prompt: '{{req.prompt}}'
    response:
      text: $.text
      messageId: $.id
      finish: $.reason
      usage: $.usage
models:
  - alias: tiny-1
    native: tiny-1
`;
