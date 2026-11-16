# @enso-app/core

The canvas logic the enso CLI and the Enso app's canvas MCP server share. It holds:

- the canvas intent and canvas spec schemas, with their validation and compilers
- the layout engine that places Notes, Regions, Excerpts and Marks
- the Link, Mark and Node appearance models
- `EnsoError` and the response envelope every client returns

It depends only on `zod`. It uses no Node APIs, so the Mac app can run it in JavaScriptCore and the Electron app can import it directly. `test/boundary.test.ts` and the package's `types: []` tsconfig keep it that way.

## Develop

The CLI resolves `@enso-app/core` to `src/index.ts` through the root tsconfig paths and `vitest.config.ts`, and its build bundles core into `dist/index.js`. Build this package alone with `npm run build -w @enso-app/core`.
