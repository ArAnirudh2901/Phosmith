"use client"

import { Toaster as Sonner } from "sonner"
import { CheckCircleIcon, InfoIcon, WarningIcon, XCircleIcon, SpinnerIcon } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

// Neo-brutalist toast — matches the rest of the editor (Projects header,
// preview controls, resolution HUD, AuroraLoader): pitch-black fill, 1.5px
// cream border, hard offset shadow, mono uppercase kicker, sharp 4px corners.
// No soft gradients, no backdrop blur, no rounded pill chrome.

const defaultIcons = {
  success: <CheckCircleIcon className="size-[14px]" weight="fill" />,
  info: <InfoIcon className="size-[14px]" weight="fill" />,
  warning: <WarningIcon className="size-[14px]" weight="fill" />,
  error: <XCircleIcon className="size-[14px]" weight="fill" />,
  loading: <SpinnerIcon className="size-[14px] animate-spin" weight="bold" />,
}

// Single base style. Variant colors come purely from the offset-shadow color
// (cyan/green/coral/amber) so the toast itself stays consistent.
const baseToast = cn(
  "neo-toast",
  "relative isolate flex items-start gap-2.5",
  "px-3.5 py-3 text-[#F4F4F5]",
  "border-[1.5px] border-[rgba(244,244,245,0.85)] bg-[#000]",
  "rounded-[4px]",
  // Default hard cyan offset shadow — variants override.
  "shadow-[4px_4px_0_0_rgba(6,184,212,0.85),inset_0_1px_0_rgba(255,255,255,0.06)]",
  "transition-shadow duration-200"
)

const defaultToastClassNames = {
  toast: baseToast,
  content: "neo-toast-content min-w-0 flex-1",
  title: cn(
    "neo-toast-title text-[12px] font-bold uppercase tracking-[0.06em] leading-[1.25] text-[#F4F4F5]"
  ),
  description: cn(
    "neo-toast-description mt-1 text-[11.5px] leading-[1.45] text-[#A1A8B4] font-normal"
  ),
  icon: cn(
    "neo-toast-icon mt-[2px] flex size-7 shrink-0 items-center justify-center",
    "rounded-[3px] border-[1.5px] border-[rgba(244,244,245,0.7)] bg-[#06B8D4] text-[#03050A]",
    "shadow-[2px_2px_0_0_rgba(244,244,245,0.4)]"
  ),
  closeButton: "neo-toast-close",
  actionButton: cn(
    "neo-toast-action inline-flex h-7 shrink-0 items-center justify-center",
    "rounded-[3px] border-[1.5px] border-[rgba(244,244,245,0.7)] bg-[#06B8D4] px-2.5",
    "text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-[#03050A]",
    "shadow-[2px_2px_0_0_rgba(244,244,245,0.55)]",
    "transition-transform duration-100",
    "hover:shadow-[3px_3px_0_0_rgba(244,244,245,0.7)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
  ),
  cancelButton: cn(
    "neo-toast-cancel inline-flex h-7 shrink-0 items-center justify-center",
    "rounded-[3px] border-[1.5px] border-[rgba(244,244,245,0.45)] bg-transparent px-2.5",
    "text-[10.5px] font-bold uppercase tracking-[0.08em] text-[#A1A8B4]",
    "transition-colors hover:text-[#F4F4F5] hover:border-[rgba(244,244,245,0.75)]"
  ),
  // Variant flags — applied via attribute on the data-type element by sonner.
  success: "neo-toast--success",
  error: "neo-toast--error",
  info: "neo-toast--info",
  warning: "neo-toast--warning",
  loading: "neo-toast--loading",
  default: "neo-toast--default",
}

const Toaster = ({
  className,
  icons,
  style,
  toastOptions,
  ...props
}) => {
  const mergedIcons = {
    ...defaultIcons,
    ...icons,
  }

  const mergedToastOptions = {
    duration: 4500,
    closeButton: true,
    unstyled: true,
    ...toastOptions,
    classNames: {
      ...defaultToastClassNames,
      ...(toastOptions?.classNames ?? {}),
    },
  }

  return (
    <Sonner
      theme="dark"
      // Top-center: matches the prior placement that sat cleanly below the
      // editor topbar. The toast container is position:fixed, so it overlays
      // the page rather than pushing content down. Offset top: 76 keeps it
      // clear of the editor's 54px topbar with a small margin.
      position="top-center"
      expand={false}
      visibleToasts={3}
      closeButton={true}
      offset={{ top: 76, right: 20, bottom: 24, left: 20 }}
      mobileOffset={{ top: 68, right: 12, bottom: 16, left: 12 }}
      gap={10}
      className={cn("toaster", className)}
      icons={mergedIcons}
      style={
        {
          "--width": "min(360px, calc(100vw - 2rem))",
          ...style,
        }
      }
      toastOptions={mergedToastOptions}
      {...props}
    />
  )
}

export { Toaster }
