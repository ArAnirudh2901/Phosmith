import Link from "next/link"

export const metadata = {
  title: "Page not found",
}

// Next's built-in 404 renders unstyled light-mode HTML, which breaks hard against
// the dark shell. Keep this a server component so it also covers notFound() throws.
export default function NotFound() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-6 py-24"
      style={{ background: "var(--bg-void-darkest)" }}
    >
      <div className="w-full max-w-lg text-center">
        <div
          className="inline-flex items-center gap-2 px-3 py-1.5 mb-8 text-[11px] tracking-[0.2em] uppercase"
          style={{
            color: "var(--accent-ink)",
            border: "1px solid var(--accent-ink-glow)",
            background: "var(--accent-ink-dim)",
          }}
        >
          <span
            className="inline-block h-2 w-2"
            style={{ background: "var(--accent-ink)" }}
            aria-hidden="true"
          />
          Error 404
        </div>

        <h1
          className="text-6xl sm:text-7xl font-bold tracking-tight mb-4"
          style={{ color: "var(--text-primary)" }}
        >
          Nothing here
        </h1>

        <p
          className="text-sm sm:text-base leading-relaxed mb-10"
          style={{ color: "var(--text-muted)" }}
        >
          This page moved, never existed, or the link is wrong. Your projects are
          untouched.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="w-full sm:w-auto px-7 py-3.5 text-[13px] font-semibold tracking-[0.12em] uppercase transition-[filter] hover:brightness-110"
            style={{
              background: "#06B8D4",
              color: "#03050A",
              border: "1.5px solid #F4F4F5",
            }}
          >
            Go to dashboard
          </Link>
          <Link
            href="/"
            className="w-full sm:w-auto px-7 py-3.5 text-[13px] font-semibold tracking-[0.12em] uppercase transition-colors hover:bg-white/5"
            style={{
              color: "#F4F4F5",
              border: "1.5px solid rgba(244, 244, 245, 0.85)",
            }}
          >
            Back home
          </Link>
        </div>
      </div>
    </div>
  )
}
