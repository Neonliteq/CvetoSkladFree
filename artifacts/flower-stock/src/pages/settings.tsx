import { useEffect, useState } from "react"
import {
  getGetAiSettingsQueryKey,
  useGetAiSettings,
  useTestAiConnection,
  useUpdateAiSettings,
} from "@workspace/api-client-react"
import type { ApiError } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, PlugZap, ShieldCheck, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { formatDateTime } from "@/lib/utils"
import { useIsAdmin } from "@/lib/auth-context"

/**
 * Готовые адреса провайдеров.
 *
 * Одно нажатие вместо поиска адреса в документации: адрес легко перепутать, а
 * ошибка в нём ломает ассистента целиком. Ключ всё равно вводится вручную.
 */
const PROVIDER_PRESETS = [
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "Локальный сервер", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5" },
]

/** Administrator-only screen: which AI provider the assistant talks to. */
export default function SettingsPage() {
  const queryClient = useQueryClient()
  const isAdmin = useIsAdmin()
  const { data: settings, isLoading } = useGetAiSettings({
    // Сотруднику этот экран не нужен, а запрос вернул бы 403: не ходим зря.
    // Сгенерированный хук требует queryKey в типе опций, хотя useQuery
    // подставляет его сам, поэтому передаём только enabled.
    query: { enabled: isAdmin },
  } as never)
  const [baseUrl, setBaseUrl] = useState("")
  const [model, setModel] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [useOwn, setUseOwn] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; answer: string } | null>(null)

  // Поля показывают свой провайдер магазина, если он сохранён; иначе — пустые,
  // и работает общий провайдер сервиса.
  useEffect(() => {
    if (settings) {
      setBaseUrl(settings.shopBaseUrl ?? "")
      setModel(settings.shopModel ?? "")
      setUseOwn(settings.source === "shop")
    }
  }, [settings])

  const reportError = (error: ApiError | null | undefined, fallback: string) => {
    const message = error?.data
    toast.error(
      message && typeof message === "object" && "error" in message
        ? String((message as { error?: unknown }).error)
        : fallback,
    )
  }

  const { mutate: save, isPending: isSaving } = useUpdateAiSettings({
    mutation: {
      onSuccess: (saved) => {
        toast.success("Настройки сохранены", {
          description:
            saved.source === "shop"
              ? `Ассистент работает через ваш провайдер: ${saved.shopBaseUrl ?? "—"} · модель ${saved.modelInUse ?? "—"}`
              : `Ассистент работает через общий провайдер сервиса${saved.platformModel ? `: модель ${saved.platformModel}` : ""}`,
          duration: 6000,
        })
        // Ключ на сервере больше не нужен в поле: он сохранён и не отдаётся наружу.
        setApiKey("")
        setCheck(null)
        queryClient.invalidateQueries({ queryKey: getGetAiSettingsQueryKey() })
      },
      onError: (error) => reportError(error, "Не удалось сохранить настройки"),
    },
  })

  const { mutate: test, isPending: isTesting } = useTestAiConnection({
    mutation: {
      onSuccess: (result) => {
        setCheck({ ok: result.ok, answer: result.answer })
        if (result.ok) toast.success("Связь с провайдером есть")
        else toast.error("Провайдер не ответил", { description: result.answer, duration: 8000 })
      },
      onError: (error) => reportError(error, "Не удалось проверить связь"),
    },
  })

  const submit = () => {
    if (!useOwn) {
      // Возврат к общему провайдеру сервиса: свои значения магазина убираются.
      save({ data: { provider: "platform" } })
      return
    }
    const trimmedBaseUrl = baseUrl.trim()
    const trimmedModel = model.trim()
    if (!trimmedBaseUrl) {
      toast.error("Укажите адрес API своего провайдера")
      return
    }
    if (!apiKey.trim() && !settings?.shopKeySet) {
      toast.error("Укажите ключ API своего провайдера")
      return
    }
    save({
      data: {
        provider: "shop",
        baseUrl: trimmedBaseUrl,
        model: trimmedModel ? trimmedModel : null,
        // Пустое поле ключа оставляет прежний ключ: владелец правит адрес или
        // модель, не вводя ключ заново.
        apiKey: apiKey.trim() ? apiKey.trim() : null,
      },
    })
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">Настройки</h1>
        <p className="text-muted-foreground mt-1">
          Подключение AI-провайдера: ассистент, распознавание накладных и ответы в мессенджерах
          работают через него
        </p>
      </div>

      {/* Экран администраторский: сотруднику он не показывается, даже если он
          открыл адрес вручную. Сервер его запросы тоже отклоняет. */}
      {!isAdmin ? (
        <Card>
          <CardContent className="flex items-start gap-2 p-4 text-sm" role="status">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              Настройки доступны администратору. Обратитесь к нему, если нужно изменить провайдера
              ассистента.
            </span>
          </CardContent>
        </Card>
      ) : (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            AI-провайдер
          </CardTitle>
          <CardDescription>
            Адрес API и модель можно менять в любой момент — ассистент подхватит их сразу,
            перезапускать службу не нужно
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Загрузка…</div>
          ) : (
            <>
              {/* Что действует прямо сейчас: общий провайдер сервиса или свой. */}
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
                {settings?.source === "shop" && (
                  <Badge variant="outline" className="border-green-600/60 text-green-700 dark:text-green-400">
                    Работает ваш провайдер
                  </Badge>
                )}
                {settings?.source === "platform" && (
                  <Badge variant="outline" className="border-blue-600/60 text-blue-700 dark:text-blue-400">
                    Работает общий провайдер сервиса
                  </Badge>
                )}
                {settings?.source === "none" && (
                  <Badge variant="outline" className="border-destructive/60 text-destructive">
                    Провайдер не настроен
                  </Badge>
                )}
                <span className="text-muted-foreground">
                  модель: <span className="text-foreground">{settings?.modelInUse ?? "—"}</span>
                </span>
                {settings?.source === "shop" && settings?.keySuffix && (
                  <span className="text-muted-foreground">
                    ваш ключ: <span className="text-foreground">{settings.keySuffix}</span>
                  </span>
                )}
                {settings?.updatedAt && (
                  <span className="text-muted-foreground">
                    изменено {formatDateTime(settings.updatedAt)}
                    {settings.updatedByName ? `, ${settings.updatedByName}` : ""}
                  </span>
                )}
              </div>

              {/* Общий провайдер сервиса: только сведения. Владелец сервиса задаёт
                  его на сервере, магазин не может ни изменить его, ни увидеть ключ. */}
              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  Общий провайдер сервиса
                </div>
                {settings?.platformConfigured ? (
                  <p className="mt-1 text-muted-foreground">
                    Настроен владельцем сервиса: {settings.platformBaseUrl ?? "—"}, модель{" "}
                    {settings.platformModel ?? "—"}. Ключ вам недоступен — он принадлежит сервису.
                    Ничего настраивать не нужно, ассистент уже работает.
                  </p>
                ) : (
                  <p className="mt-1 text-muted-foreground">
                    Не настроен. Подключите своего провайдера ниже, иначе ассистент и распознавание
                    накладных работать не будут.
                  </p>
                )}
              </div>

              <div className="space-y-3 rounded-lg border p-3">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="ai-use-own"
                    checked={useOwn}
                    onCheckedChange={(checked) => {
                      setUseOwn(checked === true)
                      setCheck(null)
                    }}
                    aria-label="Использовать свой AI-провайдер"
                    className="mt-0.5 h-6 w-6"
                  />
                  <div className="space-y-1 leading-none">
                    <Label htmlFor="ai-use-own" className="cursor-pointer">
                      Использовать свой AI-провайдер
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Включите, если хотите работать на своём ключе: тогда расходы на ассистента —
                      ваши, и общий провайдер сервиса не тратится. Выключите, чтобы вернуться к
                      общему.
                    </p>
                  </div>
                </div>

                {useOwn && (
                  <div className="space-y-5 pt-1">
                    <div className="space-y-2">
                      <Label htmlFor="ai-base-url">Адрес API</Label>
                      <Input
                        id="ai-base-url"
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        placeholder="https://api.deepseek.com/v1"
                        autoComplete="off"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">Подставить:</span>
                        {PROVIDER_PRESETS.map((preset) => (
                          <Button
                            key={preset.label}
                            type="button"
                            variant="outline"
                            className="h-9 px-3 text-xs"
                            onClick={() => {
                              setBaseUrl(preset.baseUrl)
                              setModel(preset.model)
                              setCheck(null)
                            }}
                          >
                            {preset.label}
                          </Button>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Полная ссылка на OpenAI-совместимый API, обычно с <code>/v1</code> на конце
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="ai-key">Ключ API</Label>
                      <Input
                        id="ai-key"
                        type="password"
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder={
                          settings?.shopKeySet
                            ? `сохранён ${settings.keySuffix ?? ""} — оставьте пустым, чтобы не менять`
                            : "sk-…"
                        }
                        autoComplete="new-password"
                      />
                      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <KeyRound className="h-3.5 w-3.5" />
                        Ключ хранится на сервере и никогда не отдаётся обратно — видно только последние
                        символы. Пустое поле оставляет прежний ключ.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="ai-model">Модель</Label>
                      <Input
                        id="ai-model"
                        value={model}
                        onChange={(event) => setModel(event.target.value)}
                        placeholder="deepseek-flash"
                        autoComplete="off"
                      />
                      <p className="text-xs text-muted-foreground">
                        Нужна модель, которая умеет вызывать инструменты: на этом держится разбор
                        команд и накладных
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button className="h-11 md:h-10" onClick={submit} disabled={isSaving}>
                  {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Сохранить
                </Button>
                <Button
                  variant="outline"
                  className="h-11 md:h-10"
                  onClick={() => {
                    setCheck(null)
                    test()
                  }}
                  disabled={isTesting}
                >
                  {isTesting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <PlugZap className="mr-2 h-4 w-4" />
                  )}
                  Проверить связь
                </Button>
              </div>

              {check && (
                <div
                  className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
                    check.ok
                      ? "border-green-600/40 bg-green-500/5"
                      : "border-destructive/40 bg-destructive/5"
                  }`}
                  role="status"
                >
                  {check.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  )}
                  <span>{check.answer}</span>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Проверка связи делает настоящий запрос к действующему провайдеру. Сохраняйте
                настройки только после успешной проверки — при неверном ключе ассистент перестанет
                отвечать.
              </p>
            </>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  )
}
