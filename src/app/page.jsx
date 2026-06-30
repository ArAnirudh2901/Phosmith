import Features from "@/components/Features";
import HeroSection from "@/components/hero";
import Pricing from "@/components/pricing";
import NeoButton from "@/components/neo/NeoButton";
import LandingChrome from "@/components/neo/LandingChrome";
import SiteShortcuts from "@/components/neo/SiteShortcuts";
import { ArrowRight } from "lucide-react";

export default function Home() {
    return (
        <div style={{ background: "#07090E" }}>
            <SiteShortcuts variant="marketing" />
            <LandingChrome />
            <HeroSection />
            <Features />
            <Pricing />

            <section
                className="relative py-28 md:py-36"
                style={{ background: "#07090E", borderTop: "2px solid #F4F4F5" }}
            >
                <div className="max-w-5xl mx-auto px-6">
                    <div
                        style={{
                            background: "#06B8D4",
                            border: "2px solid #F4F4F5",
                            boxShadow: "12px 12px 0 0 #F4F4F5",
                            padding: "56px 40px",
                            position: "relative",
                            overflow: "hidden",
                        }}
                    >
                        <div
                            style={{
                                position: "absolute",
                                top: 16,
                                right: 24,
                                fontFamily:
                                    'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                fontSize: 11,
                                color: "#03050A",
                                letterSpacing: "0.18em",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                opacity: 0.7,
                            }}
                        >
                            {"// open the studio"}
                        </div>
                        <h2
                            className="font-bold tracking-tight"
                            style={{
                                color: "#03050A",
                                fontSize: "clamp(40px, 7vw, 88px)",
                                lineHeight: 0.95,
                                textTransform: "uppercase",
                                letterSpacing: "-0.02em",
                                marginBottom: 16,
                            }}
                        >
                            Stop fighting<br />
                            your photo editor.
                        </h2>
                        <p
                            style={{
                                color: "#03050A",
                                fontSize: 18,
                                fontWeight: 500,
                                marginBottom: 32,
                                maxWidth: 560,
                                lineHeight: 1.5,
                            }}
                        >
                            Phosmith is a free canvas with optional AI superpowers. No download,
                            no plugins, no fragile workflows.
                        </p>
                        <NeoButton variant="secondary" size="xl" href="/dashboard">
                            Open the studio
                            <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
                        </NeoButton>
                    </div>
                </div>
            </section>

            <footer
                style={{
                    background: "#07090E",
                    borderTop: "2px solid #F4F4F5",
                    padding: "32px 24px",
                    color: "#A1A8B4",
                    fontFamily:
                        'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                    fontSize: 11,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 16,
                }}
            >
                <span style={{ color: "#F4F4F5" }}>Phosmith · AI Photo Studio</span>
                <span>© {new Date().getFullYear()} · Built for pixels</span>
            </footer>
        </div>
    );
}
