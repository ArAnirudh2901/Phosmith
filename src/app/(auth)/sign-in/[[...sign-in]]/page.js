import { SignIn } from '@clerk/nextjs'
import React from 'react'
import SiteShortcuts from '@/components/neo/SiteShortcuts'

const SignInPage = () => {
  return (
    <>
      <SiteShortcuts variant="auth" />
      <SignIn />
    </>
  )
}

export default SignInPage
