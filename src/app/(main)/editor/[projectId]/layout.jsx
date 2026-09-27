/**
 * Starts the project fetch while the page is still parsing.
 *
 * The editor's first request did not leave the browser until ~990 ms, because
 * everything waits on the client bundle booting and Clerk resolving a session.
 * The project row is ~840 KB (it is almost entirely `canvasState`), so that is
 * ~840 KB that had not begun downloading a second into the load.
 *
 * Moving the fetch itself into a server component was the obvious idea and the
 * wrong one: inlining 840 KB into the RSC payload puts it in front of first
 * paint, trading a fast blank page for a slow one. What actually helps is
 * starting the SAME request earlier, so it overlaps the JS boot instead of
 * following it. This is a server component purely so it can emit that script
 * into the document ahead of the bundle; `useDatabaseQuery` then adopts the
 * in-flight promise instead of issuing its own.
 *
 * It is a pure optimisation: if the script is blocked, the promise rejects, or
 * the hook never looks, the client fetches exactly as it did before.
 */

const preloadScript = (projectId) => {
    // Must match byte-for-byte what useDatabaseQuery would POST, or the hook
    // will not recognise it and will simply fetch again.
    const body = JSON.stringify({ name: 'projects.getProject', args: { projectId } })
    return `(function(){try{
var k=${JSON.stringify(body)};
var s=(window.__phosmithPreload=window.__phosmithPreload||{});
if(s[k])return;
s[k]=fetch('/api/neon/query',{method:'POST',headers:{'content-type':'application/json'},body:k,credentials:'same-origin'})
.then(function(r){return r.json().then(function(b){return {ok:r.ok,status:r.status,body:b}})})
.catch(function(){return null});
}catch(e){}})();`
}

export default async function EditorLayout({ children, params }) {
    const { projectId } = await params
    return (
        <>
            {projectId ? (
                <script
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: preloadScript(String(projectId)) }}
                />
            ) : null}
            {children}
        </>
    )
}
