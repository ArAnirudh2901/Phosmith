import { JetBrains_Mono } from "next/font/google";
import "@/lib/env";
import "./globals.css";
import "../styles/animations.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import LiquidCursorEffect from "@/components/liquid-cursor-effect";
import { SmoothScrollProvider } from "@/components/smooth-scroll-provider";
import { DatabaseClientProvider } from "./DatabaseClientProvider";
import DiagnosticsBoot from "@/components/diagnostics-boot"
import ProjectPreload from "@/components/project-preload"

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
})

export const metadata = {
  title: {
    default: "Phosmith — AI Image Studio",
    template: "%s · Phosmith",
  },
  description: "Professional AI-powered image editing. Generative fill, collage maker, background removal, AI agent chat — all in the browser.",
  keywords: ["AI image editor", "photo editor", "generative fill", "background removal", "collage maker", "Phosmith"],
  applicationName: "Phosmith",
  authors: [{ name: "Phosmith" }],
  creator: "Phosmith",
  metadataBase: new URL("https://phosmith.vercel.app"),
  openGraph: {
    type: "website",
    siteName: "Phosmith",
    title: "Phosmith — AI Image Studio",
    description: "Professional AI-powered image editing. Generative fill, collage maker, background removal, AI agent chat — all in the browser.",
    url: "https://phosmith.vercel.app",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Phosmith — AI Image Studio",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Phosmith — AI Image Studio",
    description: "Professional AI-powered image editing. Generative fill, collage maker, background removal, AI agent chat.",
    images: ["/og-image.png"],
  },
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
  manifest: "/manifest.json",
};

export const viewport = {
  colorScheme: "dark",
  themeColor: "#0B0D12",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: "dark" }} suppressHydrationWarning>
      <body className={`${jetbrainsMono.variable} phosmith-agent-theme bg-[var(--bg-void-dark)] text-[var(--text-primary)] antialiased`}>
        <ProjectPreload />
        <DiagnosticsBoot />
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          <DatabaseClientProvider>
            <SmoothScrollProvider>
              <LiquidCursorEffect />
              <main className="relative z-10 min-h-screen">
                <Toaster />
                {children}
              </main>
            </SmoothScrollProvider>
          </DatabaseClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
