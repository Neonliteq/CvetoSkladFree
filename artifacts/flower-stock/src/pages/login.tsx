import { useState } from "react"
import {
  getGetCurrentUserQueryKey,
  getGetTrustedDeviceQueryKey,
  useGetTrustedDevice,
  useLogin,
} from "@workspace/api-client-react"
import type { ApiError } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { KeyRound, Loader2, Sprout } from "lucide-react"
import { Link } from "wouter"

/**
 * Sign-in screen.
 *
 * When the browser is already a trusted warehouse device, the PIN shortcut is
 * offered as well — that path exists for the shared tablet, not as a replacement
 * for the password.
 */
export default function LoginPage() {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { mutate: signIn, isPending } = useLogin({
    mutation: {
      onSuccess: () => {
        // A full reload is the honest way to start a session: it drops every
        // cached response of the previous account and lets the app boot from
        // `/auth/me` with the new cookie. The path is kept, so a user who was
        // sent to the sign-in form from `/products` lands back there.
        window.location.replace(window.location.pathname + window.location.search)
      },
      onError: (mutationError) => {
        setError(mutationError.data?.error ?? "Не удалось войти. Проверьте связь с сервером.")
      },
    },
  })

  const { data: device } = useGetTrustedDevice({
    query: {
      queryKey: getGetTrustedDeviceQueryKey(),
      retry: false,
      staleTime: 5 * 60_000,
    },
  })

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!username.trim() || !password) {
      setError("Введите логин и пароль")
      return
    }
    signIn({ data: { username: username.trim(), password } })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-sm p-6 shadow-lg">
        <div className="mb-6 flex items-center gap-2 font-serif text-xl font-bold">
          <Sprout className="h-6 w-6 text-primary" />
          ФлораСклад
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="username">Логин</Label>
            <Input
              id="username"
              autoComplete="username"
              autoCapitalize="none"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Пароль</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isPending}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" className="h-11 w-full" disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Входим...
              </>
            ) : (
              "Войти"
            )}
          </Button>
        </form>

        {device && (
          <div className="mt-4 border-t pt-4">
            <p className="mb-2 text-xs text-muted-foreground">
              Это устройство склада: «{device.name}»
            </p>
            <Button asChild variant="outline" className="h-11 w-full">
              <Link href="/pin">
                <KeyRound className="mr-2 h-4 w-4" />
                Войти по PIN
              </Link>
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
