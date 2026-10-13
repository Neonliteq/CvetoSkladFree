import { useEffect, useState } from "react"
import {
  getGetCurrentUserQueryKey,
  getGetTrustedDeviceQueryKey,
  getListDeviceUsersQueryKey,
  useGetTrustedDevice,
  useListDeviceUsers,
  useLoginWithPin,
} from "@workspace/api-client-react"
import type { ApiError } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Delete, Loader2, Sprout } from "lucide-react"
import { Link, useLocation } from "wouter"

const PIN_LENGTH = 4

/**
 * PIN pad for the shared warehouse tablet.
 *
 * The PIN is short, so the safety comes from elsewhere: the device had to be
 * approved by an administrator, the attempt count is limited server-side, and a
 * failure falls back to the password.
 */
export default function PinLoginPage() {
  const [, navigate] = useLocation()
  const [pin, setPin] = useState("")
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: device, isLoading: isDeviceLoading, error: deviceError } = useGetTrustedDevice({
    query: {
      queryKey: getGetTrustedDeviceQueryKey(),
      retry: false,
      staleTime: 5 * 60_000,
    },
  })
  const { data: users, isLoading: isUsersLoading } = useListDeviceUsers({
    query: {
      queryKey: getListDeviceUsersQueryKey(),
      enabled: Boolean(device),
      retry: false,
    },
  })
  const user = users?.[0]

  const { mutate: signIn, isPending } = useLoginWithPin({
    mutation: {
      onSuccess: () => {
        // Reloading from `/auth/me` guarantees no state of the previous session
        // is reused on a shared tablet.
        window.location.replace("/")
      },
      onError: (mutationError) => {
        setError(mutationError.data?.error ?? "Не удалось войти по PIN")
        setPin("")
      },
    },
  })

  // Four digits is the whole code, so submission is automatic.
  useEffect(() => {
    if (pin.length === PIN_LENGTH && user && !isPending) {
      setError(null)
      signIn({ data: { userId: user.id, pin } })
    }
  }, [pin, user, isPending, signIn])

  if (deviceError) {
    return (
      <PinShell>
        <p className="text-sm text-muted-foreground">
          Это устройство больше не является доверенным. Войдите логином и паролем.
        </p>
        <Button asChild className="mt-4 h-11 w-full">
          <Link href="/login">К входу по паролю</Link>
        </Button>
      </PinShell>
    )
  }

  const ready = Boolean(device) && Boolean(user)
  const loading = isDeviceLoading || isUsersLoading

  return (
    <PinShell>
      {loading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Проверяем устройство...</p>
      ) : !ready ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Загрузка...</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {user?.hasPin
              ? `${user.displayName}, введите PIN`
              : `${user?.displayName}: PIN не задан. Войдите паролем.`}
          </p>

          <div className="my-5 flex justify-center gap-3" aria-label="Введённые цифры">
            {Array.from({ length: PIN_LENGTH }).map((_, index) => (
              <span
                key={index}
                className={`h-4 w-4 rounded-full border-2 ${
                  index < pin.length ? "border-primary bg-primary" : "border-muted-foreground/40"
                }`}
              />
            ))}
          </div>

          {error && (
            <p role="alert" className="mb-3 text-center text-sm text-destructive">
              {error}
            </p>
          )}

          {/* Large targets: the tablet is used one-handed, often in gloves. */}
          <div className="grid grid-cols-3 gap-2">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
              <Button
                key={digit}
                type="button"
                variant="outline"
                className="h-14 text-lg"
                disabled={isPending || pin.length >= PIN_LENGTH || !user?.hasPin}
                onClick={() => setPin((current) => (current + digit).slice(0, PIN_LENGTH))}
              >
                {digit}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              className="h-14"
              disabled={isPending || pin.length >= PIN_LENGTH || !user?.hasPin}
              onClick={() => setPin("0")}
            >
              0
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-14"
              aria-label="Удалить цифру"
              disabled={isPending || !pin.length}
              onClick={() => setPin((current) => current.slice(0, -1))}
            >
              <Delete className="h-5 w-5" />
            </Button>
          </div>

          {isPending && (
            <p className="mt-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Проверяем PIN...
            </p>
          )}

          <div className="mt-5 border-t pt-4 text-center">
            <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground">
              Войти другим сотрудником
            </Link>
          </div>
        </>
      )}
    </PinShell>
  )
}

function PinShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-sm p-6 shadow-lg">
        <div className="mb-6 flex items-center gap-2 font-serif text-xl font-bold">
          <Sprout className="h-6 w-6 text-primary" />
          ФлораСклад
        </div>
        {children}
      </Card>
    </div>
  )
}
