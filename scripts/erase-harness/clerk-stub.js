// Signed-in Pro user, no network: the panel's gates open and nothing calls Clerk.
export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: 'harness', has: () => true, getToken: async () => null })
export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: 'harness', primaryEmailAddress: { emailAddress: 'harness@example.com' } } })
export const useSubscription = () => ({ data: null, isLoaded: true })
