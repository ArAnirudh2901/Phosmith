/**
 * Starts the editor's project fetch while the document is still parsing.
 *
 * The editor's first request otherwise leaves at ~990 ms — the cost of the
 * client bundle booting and Clerk resolving a session — and a project row is
 * ~840 KB, almost entirely `canvasState`. Moving the fetch into a server
 * component was the obvious idea and the wrong one: inlining 840 KB into the
 * RSC payload puts it in front of first paint. Starting the SAME request early
 * is what helps, so it overlaps the boot instead of following it.
 *
 * Why a raw `<script>` in the ROOT layout, and not the two obvious alternatives:
 *
 *   - A `<script>` in the editor's own route layout is what shipped first, and
 *     it was wrong twice over: React never executes a script element rendered
 *     during a CLIENT render, so the preload was silently dead on every soft
 *     navigation into the editor, and React logged a console error each time.
 *     The root layout does not re-render on navigation, so the element is only
 *     ever part of the server-rendered document.
 *   - `next/script` with `beforeInteractive` looks like the idiomatic answer but
 *     is slower here: for an inline script it emits a stub that pushes onto
 *     `self.__next_s` for Next's runtime to execute, so the fetch would wait for
 *     that runtime — the very delay this exists to avoid.
 *
 * The project id comes from `location.pathname` at run time rather than route
 * params, which is what lets this live in the root layout with no per-route
 * wiring. Pure optimisation: if the script is blocked, the promise rejects, or
 * the hook never looks, `useDatabaseQuery` fetches exactly as it did before.
 *
 * A soft navigation has no server-rendered document, so `lib/query-preload.js`
 * does the same thing from the dashboard's project card. The two must agree on the
 * payload key, since that is what `useDatabaseQuery` looks the promise up by.
 */

const PRELOAD = `(function(){try{
var m=location.pathname.match(/\\/editor\\/([A-Za-z0-9_-]{6,})/);
if(!m)return;
var k=JSON.stringify({name:'projects.getProject',args:{projectId:m[1]}});
var s=(window.__phosmithPreload=window.__phosmithPreload||{});
if(s[k])return;
s[k]=fetch('/api/neon/query',{method:'POST',headers:{'content-type':'application/json'},body:k,credentials:'same-origin'})
.then(function(r){return r.json().then(function(b){return {ok:r.ok,status:r.status,body:b}})})
.catch(function(){return null});
}catch(e){}})();`

export default function ProjectPreload() {
    // eslint-disable-next-line react/no-danger
    return <script dangerouslySetInnerHTML={{ __html: PRELOAD }} />
}
