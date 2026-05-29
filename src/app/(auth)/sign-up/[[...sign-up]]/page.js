import { SignUp } from '@clerk/nextjs'
import React from 'react'
import SiteShortcuts from '@/components/neo/SiteShortcuts'

const SignUpPage = () => {
    return (
        <>
            <SiteShortcuts variant="auth" />
            <SignUp />
        </>
    )
}

export default SignUpPage
