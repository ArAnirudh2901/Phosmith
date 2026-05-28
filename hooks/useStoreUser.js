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
    const { mutate: storeUser } = useDatabaseMutation(api.users.store);
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

                try {
                    const response = await fetch("/api/billing/sync", {
                        method: "POST",
                    });

                    if (!response.ok) {
                        throw new Error("Billing plan sync failed.");
                    }
                } catch (syncError) {
                    console.error("Failed to sync billing plan to Neon.", syncError);
                }

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

                console.error("Failed to store signed-in user in Neon.", error);
                toast.error(message);
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
        databaseSetupMissing,
    };
}
