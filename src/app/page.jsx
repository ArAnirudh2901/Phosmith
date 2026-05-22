import Features from "@/components/Features";
import HeroSection from "@/components/hero";
import Pricing from "@/components/pricing";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export default function Home() {
  return (
    <div>
      <HeroSection />
      <Features />
      <Pricing />

      <section className="py-20 text-center">
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-4xl sm:text-5xl font-bold mb-6 tracking-tight">
            Ready to
            <span className="bg-[linear-gradient(90deg,var(--accent-emerald),var(--accent-ink),var(--accent-magenta))] bg-clip-text text-transparent">
              {" "}
              Create Awesomeness
            </span>
          </h2>
          <p className="text-xl text-gray-300 mb-8">
            Join thousands of creators who are already using AI to transform
            their images and bring their vision to life.
          </p>
          <Button asChild variant="primary" size="xl">
            <Link href="/dashboard">Start Creating Now</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
