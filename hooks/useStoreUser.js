import { useAuth, useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { api } from "@/lib/neon-api";
import { isDatabaseSetupError } from "@/lib/database-errors";
import { useDatabaseMutation } from "./useDatabaseQuery";
import { toast } from "sonner";

export function useStoreUser() {
    const { isLoaded, isSignedIn, has } = useAuth();
    const { user } = useUser();
    const isPro = has?.({ plan: "pro" }) || false;
    // When this state is set we know the server
    // has stored the user.
    const [userId, setUserId] = useState(null);
    const [databaseSetupMissing, setDatabaseSetupMissing] = useState(false);
    // Storing the user touches lastActiveAt and nothing any query renders, so it
    // must not invalidate them. Broadcasting from here made every page load
    // fetch the project row twice.
    const { mutate: storeUser } = useDatabaseMutation(api.users.store, { invalidates: [] });
    // Call the `storeUser` mutation function to store
    // the current user in the `users` table and return the `Id` value.
    useEffect(() => {
        let isCancelled = false;

        // Wait until auth has settled and we have a Clerk user id before syncing.
        if (!isLoaded || !isSignedIn || !user?.id) {
            setDatabaseSetupMissing(false);
            return () => {
                isCancelled = true;
            };
        }

        // Store the user in the database.
        // Recall that `storeUser` gets the user information via the `auth`
        // object on the server. You don't need to pass anything manually here.
        async function createUser() {
            try {
                const id = await storeUser();
                setDatabaseSetupMissing(false);

                // The app is usable the moment the user row is known. Billing is
                // reconciled in the background — awaiting it here put a second
                // serial round trip in front of every page render.
                fetch("/api/billing/sync", { method: "POST" })
                    .then((response) => {
                        if (!response.ok) throw new Error("Billing plan sync failed.");
                    })
                    .catch((syncError) => {
                        console.error("Failed to sync billing plan to Neon.", syncError);
                    });

                if (!isCancelled) {
                    setUserId(id);
                }
            } catch (error) {
                if (isDatabaseSetupError(error)) {
                    if (!isCancelled) {
                        setUserId(null);
                        setDatabaseSetupMissing(true);
                    }
                    return;
                }

                if (!isCancelled) {
                    setUserId(null);
                    setDatabaseSetupMissing(false);
                }

                const message =
                    error instanceof Error
                        ? error.message
                        : "Unable to sync your account right now.";

                if (error?.status === 401) {
                    console.warn("Transient 401 storing signed-in user in Neon.", error.message);
                } else {
                    console.error("Failed to store signed-in user in Neon.", error);
                    toast.error(message);
                }
            }
        }

        createUser();

        return () => {
            isCancelled = true;
            setUserId(null);
        };
        // Make sure the effect reruns if the user logs in with
        // a different identity
    }, [isLoaded, isSignedIn, isPro, storeUser, user?.id]);
    // Combine the local state with the state from context
    return {
        isLoading: !isLoaded || (isSignedIn && userId === null && !databaseSetupMissing),
        isAuthenticated: isSignedIn && userId !== null,
        // READS can start as soon as Clerk has a session: every Neon function
        // authenticates from that session itself and creates the user row if it
        // is missing. Gating them on `isAuthenticated` made them wait for the
        // users.store write first, which put a whole round trip in front of the
        // first query on every page load.
        isSessionReady: isLoaded && Boolean(isSignedIn),
        databaseSetupMissing,
    };
}
