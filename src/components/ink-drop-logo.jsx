import { memo } from 'react'

const InkDropLogo = memo(function InkDropLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="20" stroke="url(#ringGrad)" strokeWidth="1.5" opacity="0.3" />
      <circle cx="24" cy="24" r="16" stroke="url(#ringGrad)" strokeWidth="0.8" opacity="0.2" />

      <path d="M24 4C24 4 10 20 10 24C10 27.31 12.69 30 16 30C19.31 30 22 27.31 22 24C22 22 21 20 20 18C19.5 19 18.5 20 17.5 20C15.57 20 14 18.43 14 16.5C14 15.5 14.5 14.5 15 14L24 4Z" fill="url(#dropGrad1)" opacity="0.9" />
      <path d="M24 4C24 4 10 20 10 24C10 27.31 12.69 30 16 30C19.31 30 22 27.31 22 24C22 22 21 20 20 18C19.5 19 18.5 20 17.5 20C15.57 20 14 18.43 14 16.5C14 15.5 14.5 14.5 15 14L24 4Z" fill="url(#dropGrad2)" opacity="0.3" transform="translate(1.5, 1.5)" />

      <path d="M18 10C17 12 15.5 15.5 16 18.5C16.5 21 17.5 22.5 19 23" stroke="white" strokeWidth="1" opacity="0.25" strokeLinecap="round" fill="none" />

      <circle cx="11" cy="28" r="1.2" fill="#00E5FF" opacity="0.38" />
      <circle cx="30" cy="30" r="1" fill="#D946EF" opacity="0.32" />
      <circle cx="34" cy="22" r="0.8" fill="#C8956C" opacity="0.38" />
      <circle cx="13" cy="34" r="0.7" fill="#00E5FF" opacity="0.24" />
      <circle cx="28" cy="18" r="0.9" fill="#D946EF" opacity="0.3" />

      <path d="M14 16L19 11" stroke="white" strokeWidth="0.5" opacity="0.15" strokeLinecap="round" />
      <path d="M16 14L21 9" stroke="white" strokeWidth="0.5" opacity="0.1" strokeLinecap="round" />

      <defs>
        <linearGradient id="dropGrad1" x1="10" y1="4" x2="24" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#00E5FF" />
          <stop offset="0.5" stopColor="#7C3AED" />
          <stop offset="1" stopColor="#D946EF" />
        </linearGradient>
        <linearGradient id="dropGrad2" x1="10" y1="4" x2="24" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#C8956C" />
          <stop offset="1" stopColor="#FBBF24" />
        </linearGradient>
        <linearGradient id="ringGrad" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#00E5FF" />
          <stop offset="0.5" stopColor="#D946EF" />
          <stop offset="1" stopColor="#C8956C" />
        </linearGradient>
      </defs>
    </svg>
  )
})

export default InkDropLogo
