import { useState } from "react"
import { useLocation, useRoute } from "wouter"
import { useCompleteSetup, useInspectSetupLink } from "@workspace/api-client-react"
import type { ApiError } from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertTriangle, CheckCircle2, Loader2, Sprout } from "lucide-react"

/**
 * Первый вход нового магазина по одноразовой ссылке.
 *
 * Владелец магазина открывает ссылку и сам задаёт логин и пароль — пароль нигде не
 * пересылается и его не видит владелец сервиса. Экран открыт без сессии: до этого шага
 * входа в системе ещё нет.
 */
export default function SetupPage() {
  const [, params] = useRoute<{ token: string }>("/setup/:token")
  const [, navigate] = useLocation()
  const token = params?.token ?? ""
  const [username, setUsername] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const { data: state, isLoading } = useInspectSetupLink(token, {
    query: { enabled: token.length > 0 },
  } as never)

  const { mutate: complete, isPending } = useCompleteSetup({
    mutation: {
      onSuccess: () => {
        setError(null)
        setDone(true)
      },
      onError: (apiError) => {
        const data = (apiError as ApiError | null)?.data
        setError(
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: unknown }).error)
            : "Не удалось завершить настройку",
        )
      },
    },
  })

  const submit = () => {
    setError(null)
    if (username.trim().length < 3) {
      setError("Логин — от трёх символов")
      return
    }
    if (password.length < 8) {
      setError("Пароль — от восьми символов")
      return
    }
    if (password !== repeat) {
      setError("Пароли не совпадают")
      return
    }
    complete({
      data: {
        token,
        username: username.trim(),
        displayName: displayName.trim() ? displayName.trim() : null,
        password,
      },
    })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Sprout className="h-5 w-5 text-sidebar-primary" />
            ФлораСклад
          </CardTitle>
          <CardDescription>
            {done
              ? "Готово: администратор магазина создан"
              : "Первый вход: задайте логин и пароль администратора вашего магазина"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {done ? (
            <div className="space-y-4">
              <div
                className="flex items-start gap-2 rounded-lg border border-green-600/40 bg-green-500/5 p-3 text-sm"
                role="status"
              >
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                <span>
                  Магазин готов к работе. Войдите под логином <strong>{username.trim()}</strong> и
                  паролем, который вы только что задали.
                </span>
              </div>
              <Button className="h-11 w-full md:h-10" onClick={() => navigate("/login")}>
                Перейти ко входу
              </Button>
            </div>
          ) : isLoading ? (
            <div className="text-sm text-muted-foreground">Проверяем ссылку…</div>
          ) : state && state.status !== "valid" ? (
            // Ссылку нельзя использовать — говорим, что именно случилось, чтобы человек
            // понимал, просить новую или он просто перепутал адрес.
            <div className="space-y-3">
              <div
                className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
                role="status"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <span>
                  {state.status === "used"
                    ? "Этой ссылкой уже воспользовались. Если нужно завести ещё магазин, попросите новую."
                    : state.status === "expired"
                      ? "Срок действия ссылки истёк. Попросите новую — она выдаётся на сутки."
                      : "Ссылка не найдена. Проверьте, что адрес скопирован целиком."}
                </span>
              </div>
              <Button variant="outline" className="h-11 w-full md:h-10" onClick={() => navigate("/login")}>
                Ко входу
              </Button>
            </div>
          ) : (
            <>
              {state?.status === "valid" && (
                <p className="text-sm text-muted-foreground">
                  Магазин: <span className="text-foreground">{state.shopName}</span>
                </p>
              )}

              <div className="space-y-2">
                <Label htmlFor="setup-username">Логин</Label>
                <Input
                  id="setup-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="Например, lena"
                  autoComplete="username"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-name">Как вас показывать</Label>
                <Input
                  id="setup-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Например, Елена — владелец"
                  autoComplete="name"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-password">Пароль</Label>
                <Input
                  id="setup-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="От восьми символов"
                  autoComplete="new-password"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-repeat">Повторите пароль</Label>
                <Input
                  id="setup-repeat"
                  type="password"
                  value={repeat}
                  onChange={(event) => setRepeat(event.target.value)}
                  autoComplete="new-password"
                />
              </div>

              {error && (
                <div
                  className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
                  role="alert"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <span>{error}</span>
                </div>
              )}

              <Button className="h-11 w-full md:h-10" onClick={submit} disabled={isPending}>
                {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Создать администратора
              </Button>
              <p className="text-xs text-muted-foreground">
                Ссылка одноразовая и действует сутки. Пароль никуда не отправляется: его видите
                только вы.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
