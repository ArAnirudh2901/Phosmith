import { Suspense } from 'react'
import ClerkShell from '@/app/clerk-shell'
import Header from '@/components/header'
import { HeaderFallback } from '@/components/header-shell'

const AuthLayout = ({ children }) => (
    <ClerkShell>
        <Suspense fallback={<HeaderFallback />}>
            <Header />
        </Suspense>
        <div className='flex justify-center pt-48'>{children}</div>
    </ClerkShell>
)

export default AuthLayout
