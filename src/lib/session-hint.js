// Is a Clerk session present, without loading Clerk? Clerk publishes __client_uat
// (a readable "user authenticated at" timestamp) exactly so a page can answer this
// before its SDK boots. Returns false during SSR.

export function hasSessionCookie() {
  if (typeof document === 'undefined') return false
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=')
    const name = (eq === -1 ? part : part.slice(0, eq)).trim()
    const value = eq === -1 ? '' : part.slice(eq + 1).trim()
    if (name === '__session' || name.startsWith('__session_')) return value.length > 0
    if (name.startsWith('__client_uat')) return Number(value) > 0
  }
  return false
}
