import { dark } from "@clerk/themes";

// Shared by the Clerk shell of the app routes and the account control on the
// marketing page, so both render the same themed widgets.

// Clerk renders {{applicationName}} from the dashboard instance name; override it
// here so the auth screens stay on-brand no matter which instance is wired up.
export const clerkLocalization = {
  signIn: { start: { title: "Sign in to Phosmith" } },
  signUp: { start: { title: "Create your Phosmith account" } },
};

export const clerkAppearance = {
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
    userButtonAvatarBox: "ring-2 ring-[#53D8FF]/30 max-md:!size-11",
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
