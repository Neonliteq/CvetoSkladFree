import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import {
  getGetCurrentUserQueryKey,
  logout,
  useGetCurrentUser,
} from "@workspace/api-client-react"
import type { AuthSession, AuthUser } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { ApiError } from "@workspace/api-client-react"

type AuthContextValue = {
  user: AuthUser
  session: AuthSession
  signOut: () => void
  isSigningOut: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({
  session,
  children,
}: {
  session: AuthSession
  children: ReactNode
}) {
  const queryClient = useQueryClient()
  const [isSigningOut, setIsSigningOut] = useState(false)

  const signOut = async () => {
    setIsSigningOut(true)
    try {
      // The server ends the session; a failure here must still leave the app in
      // the signed-out state, so the response is not checked.
      await logout()
    } catch {
      // ignore: the local state is cleared below either way
    } finally {
      await queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() })
      // Anything cached belongs to the account that just left.
      queryClient.clear()
      setIsSigningOut(false)
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user: session.user,
        session,
        signOut: () => void signOut(),
        isSigningOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

/** The signed-in user. Only callable inside the authenticated part of the app. */
export function useCurrentUser() {
  const context = useContext(AuthContext)
  if (!context) throw new Error("useCurrentUser must be used inside AuthProvider")
  return context
}

export function useIsAdmin() {
  return useCurrentUser().user.role === "admin"
}

/**
 * Session lookup used before the app decides what to render.
 *
 * `unauthorized` is deliberately sticky until a lookup actually succeeds: the
 * session is gone the moment the API answers 401, and only a successful answer
 * may bring it back. Without that, a pending request could flip the UI back to a
 * signed-in state the server has already rejected.
 */
export function useSession() {
  const { data, isLoading, error } = useGetCurrentUser({
    query: {
      queryKey: getGetCurrentUserQueryKey(),
      // A 401 is a normal state here, not something to retry.
      retry: false,
      staleTime: 60_000,
    },
  })

  const [unauthorized, setUnauthorized] = useState<boolean | null>(null)

  useEffect(() => {
    if (error instanceof ApiError && error.response?.status === 401) setUnauthorized(true)
  }, [error])

  useEffect(() => {
    if (data) setUnauthorized(false)
  }, [data])

  // A server rejection from this or an earlier request wins until data arrives.
  if (unauthorized || (error && !data)) {
    return { session: undefined, isLoading: false, unauthorized: true }
  }
  return { session: data, isLoading, unauthorized: false }
}
