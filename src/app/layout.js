import { JetBrains_Mono } from "next/font/google";
import { Suspense } from "react";
import "@/lib/env";
import "./globals.css";
import "../styles/animations.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import LiquidCursorEffect from "@/components/liquid-cursor-effect";
import { SmoothScrollProvider } from "@/components/smooth-scroll-provider";
import Header from "@/components/header";
import { DatabaseClientProvider } from "./DatabaseClientProvider";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
})

const clerkAppearance = {
  baseTheme: dark,
  variables: {
    colorPrimary: "#53D8FF",
    colorPrimaryForeground: "#050508",
    colorTextOnPrimaryBackground: "#050508",
    colorBackground: "#0C0F15",
    colorInputBackground: "rgba(12, 15, 21, 0.78)",
    colorInputText: "#E8ECF6",
    colorText: "#E8ECF6",
    colorTextSecondary: "#8892A4",
    colorNeutral: "#E8ECF6",
    colorDanger: "#F43F5E",
    borderRadius: "14px",
  },
  elements: {
    card: "bg-[#0C0F15]/95 border border-white/10 shadow-2xl backdrop-blur-xl !text-slate-100",
    main: "text-white",
    headerTitle: "!text-white",
    headerSubtitle: "!text-white",
    formHeaderTitle: "!text-white",
    formHeaderSubtitle: "!text-white",
    dividerText: "text-white",
    dividerLine: "bg-white/10",
    socialButtonsBlockButton:
      "bg-white/5 border border-white/10 text-white hover:bg-white/10 backdrop-blur-md",
    socialButtonsBlockButtonText: "!text-white",
    formFieldLabelRow: "!text-white",
    formFieldLabel: "!text-white",
    formFieldInput:
      "bg-white/5 border border-white/10 text-white placeholder:text-slate-500 rounded-xl backdrop-blur-md",
    formFieldHintText: "text-white",
    formFieldErrorText: "text-rose-300",
    formResendCodeLink: "text-[#53D8FF] hover:text-[#53D8FF]",
    formButtonPrimary:
      "bg-[#53D8FF] !text-[#050508] hover:!text-[#050508] focus:!text-[#050508] !justify-center !items-center !text-center gap-2 border border-white/10 rounded-xl font-semibold hover:brightness-110 transition-all",
    footerActionText: "text-white",
    footerActionLink: "text-[#53D8FF] hover:text-[#53D8FF]",
    userButtonAvatarBox: "ring-2 ring-[#53D8FF]/30",
    userButtonPopoverCard: "bg-[#0C0F15]/95 border border-white/10 shadow-2xl backdrop-blur-xl !text-white",
    userButtonPopoverMain: "text-white",
    userButtonPopoverActions: "border-t border-white/10",
    userButtonPopoverActionButton: "text-white hover:bg-white/10",
    userButtonPopoverActionButtonIcon: "text-white",
    userButtonPopoverFooter: "border-t border-white/10",
    userButtonPopoverFooterPagesLink: "text-[#53D8FF] hover:text-[#53D8FF]",
    userPreviewTextContainer: "text-white",
    userPreviewMainIdentifier: "text-white",
    userPreviewMainIdentifierText: "text-white",
    userPreviewSecondaryIdentifier: "text-white",
    identityPreviewText: "text-white",
  },
};

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

export default function RootLayout({ children }) {
  return (
    <ClerkProvider
      afterSignOutUrl="/"
      appearance={clerkAppearance}
    >
      <html lang="en" className="dark" suppressHydrationWarning>
        <body className={`${jetbrainsMono.variable} phosmith-agent-theme bg-[var(--bg-void-dark)] text-[var(--text-primary)] antialiased`}>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem={false}
            disableTransitionOnChange
          >
            <DatabaseClientProvider>
              <SmoothScrollProvider>
                <LiquidCursorEffect />
                <Suspense
                  fallback={
                    <div
                      className="fixed top-0 left-0 right-0 z-50 flex justify-center pt-4 sm:pt-6 px-4 pointer-events-none"
                      aria-hidden="true"
                    >
                      <div className="h-[52px] sm:h-[56px] w-full max-w-6xl rounded-full bg-white/[0.04] border border-white/10" />
                    </div>
                  }
                >
                  <Header />
                </Suspense>
                <main className="relative z-10 min-h-screen">
                  <Toaster />
                  {children}
                </main>
              </SmoothScrollProvider>
            </DatabaseClientProvider>
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
