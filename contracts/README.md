# API contract

`openapi/nuvrion-v1.yaml` describes the REST API (OpenAPI 3.1): 69 operations, the request and response of each, who may call
it (`x-required-permission`) and how it authenticates. `messages/task-queued.schema.json` describes the message in use on the task queue (just the task id; the broker tests check that what is really published matches it). `messages/task-command.schema.json` is a planned, richer command message that nothing produces yet.

The description is checked, not just written:

- **Contract tests** (`apps/api/test/api-contract.test.js`) start the API in-process and call every operation with real HTTP
  requests. Each request is validated against the description before it is sent; each response must have a documented
  status, a body that matches the schema and the documented headers. They also assert that the documented operations are exactly
  the routes the server implements, and that the permission each operation names is the one the server enforces.
- **Breaking-change check** (`tools/check-api-compat.js`, run in CI against the previous commit, for the OpenAPI description and for every message schema) fails the build when a change
  would break an existing client, producer or consumer: a removed operation, status or response field, a retyped response field, a new required request
  field, a tighter request limit, or stronger authentication. Put `[breaking-api-change]` in the commit message or pull request
  title to record that a break is intended.

To change the API: edit the route in `apps/api/src/server.js` and the description in the same commit, then run `npm test`.
Adding an operation without describing it, or describing one that does not exist, fails the route-parity test.

Known limits: operations that need a real provider (a Workstation agent for host-drive browsing, a running VM with a console,
the host-side update helper, and cancel, retry and reconcile of tasks in states the in-process worker passes through instantly)
are called for their documented errors but not for their success response; the contract tests list them explicitly.
Response schemas for provider pass-through data (VM settings, hardware, media listings) describe the fields the console relies on,
not every field a provider may add.
