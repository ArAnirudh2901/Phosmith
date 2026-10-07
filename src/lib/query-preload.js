// Start a Neon query before the code that needs it exists, and park the promise
// where useDatabaseQuery adopts it.
//
// The root layout's inline <script> does this for a hard load into the editor,
// but it runs only on a server-rendered document — a soft navigation from the
// dashboard pays the full serial chain instead (route transition, then the project
// row). This is the same mechanism for the callers that are already in the client
// bundle, so the key format must match project-preload.jsx exactly.

const key = (name, args) => JSON.stringify({ name, args })

// A press that navigates adopts its preload well inside this. One that did not
// (Cmd-click, right-click > new tab) must not serve that row minutes later.
const PRELOAD_TTL_MS = 10_000

/** Fire the request now, or do nothing if it is already in flight. */
export function preloadQuery(name, args) {
  if (typeof window === 'undefined') return
  const payload = key(name, args)
  const store = (window.__phosmithPreload = window.__phosmithPreload || {})
  if (store[payload]) return
  const pending = fetch('/api/neon/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    credentials: 'same-origin',
  })
    .then((r) => r.json().then((body) => ({ ok: r.ok, status: r.status, body })))
    .catch(() => null)
  store[payload] = pending
  setTimeout(() => {
    if (store[payload] === pending) delete store[payload]
  }, PRELOAD_TTL_MS)
}

/** The editor's project row — the one request worth starting on a card press. */
export const preloadProject = (projectId) => preloadQuery('projects.getProject', { projectId })

// The two reads the dashboard blocks on. Both are gated on the Clerk client SDK
// there, which the marketing route does not carry, so a press-to-paint measured
// the Clerk download and boot before the first query left. The API route
// authenticates from the session cookie, so neither read needs the SDK.
export function preloadDashboard() {
  preloadQuery('projects.getUserProjects', {})
  preloadQuery('users.getCurrentUser', {})
}
