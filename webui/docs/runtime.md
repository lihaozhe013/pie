# Runtime

Pie is one Node.js process and one React app. Vite builds both; Hono serves the API; the same server
also serves the built interface. Next.js is gone.

## Why Next.js was replaced

Next.js compiled every client component twice, carried a Rust compiler binary at runtime, and
dominated the packaged desktop payload. Measured in this checkout before the change:

| Item                                | Size   |
| ----------------------------------- | ------ |
| `node_modules/next/dist`            | 204 MB |
| `node_modules/@next/swc-<platform>` | 106 MB |
| `.next/server` (a second build)     | 71 MB  |
| `.next/static`                      | 11 MB  |
| `@earendil-works/*` (Pi runtime)    | 39 MB  |

None of it served a purpose here: nothing rendered on the server, and the API was a thin JSON layer
over in-process Pi sessions. The replacement adds roughly 2 MB of framework code and one compiled
copy of the application.

## Processes

| Command              | What runs                                                                 |
| -------------------- | ------------------------------------------------------------------------- |
| `bun run dev`        | Vite dev server on 30141, Node server on 30142, Vite proxies `/api` to it  |
| `bun run build`      | Vite client build to `dist/`, then the server bundle to `build/server/`    |
| `bun run start`      | `bin/pie.js`, which starts `build/server/index.mjs` and opens the browser  |

`scripts/dev.mjs` starts all three development pieces: it builds the server once, runs it under
`node --watch`, and keeps a Vite watch build next to the UI dev server. The API therefore runs the
same compiled bundle a release ships. The interface answers on 30141 in development, the port a
release uses, so a bookmark or the desktop shell finds it in both modes; only the API moves, to
30142, and Vite forwards `/api` there. `bun run dev:lan` listens on every interface.

The desktop shell is unchanged in kind: `src-tauri/` starts `bin/pie.js`, waits for the `Ready` line
on stdout, and loads the loopback URL. See [desktop shell](desktop.md).

## Request path

`server/index.ts` starts the listener and installs the process hooks; `server/app.ts` assembles the
middleware and the routes:

1. `compress()` gzips every compressible body over 1 KiB and sets `Vary: Accept-Encoding`. Routes do
   not compress anything themselves, and SSE responses are excluded by content type.
2. `security()` guards `/`, `/login`, and `/api/*`: host and origin allow-listing from
   `lib/request-security.ts`, then the optional `PIE_PASSWORD` check with the session cookie,
   `Basic` compatibility, and the shared failure throttle. It is a port of the interceptor the
   project ran before the migration, behavior included.
3. Routes answer from `server/api/**`, registered in `server/routes.ts`.
4. `registerStatic()` serves `dist/`: the app shell for `/` and `/login`, the real file for anything
   the bundle contains, and a 404 for a missing file with an extension.

`server/http.ts` defines the shape every handler keeps: a Web `Request` in, a Web `Response` out, with
`{ params: Promise<...> }` as the second argument. `server/hono-route.ts` is the only module that
knows about Hono; it supplies the path parameters and hands the raw `Request` to the handler. That
keeps a route callable as a plain function, and it keeps the handler logic independent of the
framework.

## Routes

`server/routes.ts` is generated from the file tree so the URL and the file name cannot drift:

```sh
node scripts/generate-routes.mjs
```

The generator registers literal paths before parameterized ones, maps `[id]` to `:id`, and maps a
rest directory such as `[...path]` to a wildcard whose segments arrive as `params.path`. It also
names the handler for each file, so adding a route is: add `server/api/<path>/route.ts`, export the
methods, regenerate, and commit both files. `bun run build` runs the generator first, so a release
can never ship a route the registry does not know about.

## The interface

`index.html` carries the head the deleted `app/layout.tsx` produced: the theme init script (from
`lib/theme.mts`, injected by a Vite plugin), the manifest and icon links, viewport settings, and the
translation opt-out. `src/main.tsx` imports the stylesheets, picks the login form or the app shell
from the path, and mounts React.

`hooks/useAppLocation.ts` provides `useRouter` and `useSearchParams` over `history` and `popstate`,
which is what the shell was written against. `?mode=tasks`, `?session=`, and `?cwd=` stay real URLs,
and links keep working as links.

## Build metadata

`scripts/build-info.mjs` reads the package version, the Git commit, and the installed Pi release, and
`vite.config.mts` defines them as `process.env.VITE_APP_VERSION`, `VITE_APP_COMMIT`,
`VITE_PI_VERSION`, and `VITE_PIE_DESKTOP`. `lib/build-info.ts` is the only module that reads them.
The portable packager forwards the commit as `PIE_COMMIT`, because its source copy has no `.git`; the
desktop build sets `VITE_PIE_DESKTOP=1` so the service worker stays unregistered in a webview.

`/manifest.webmanifest` is built per request by the server, because `PIE_APP_NAME` is a launch
setting rather than a build setting.

## Verification

Nothing in this project runs automatically and there are no tests. After a change, build it and look:
`bun run build`, then `bun run start`, then work through the surface you touched — a session round
trip for chat changes, the login flow for middleware changes, `/api/files` for path handling.
