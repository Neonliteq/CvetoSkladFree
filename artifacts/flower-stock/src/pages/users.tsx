import { useState } from "react"
import {
  getListChannelLinksQueryKey,
  getListUsersQueryKey,
  useClaimChannelLink,
  useCreateUser,
  useListChannelLinks,
  useListUsers,
  useRevokeUserDevices,
  useTrustCurrentDevice,
  useUnlinkChannel,
  useUpdateUser,
} from "@workspace/api-client-react"
import type { ApiError, ManagedUser } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { KeyRound, Link2, Loader2, MessageSquare, ShieldCheck, Smartphone, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { formatDateTime } from "@/lib/utils"

type Draft = {
  id?: number
  username: string
  displayName: string
  password: string
  role: "admin" | "staff"
}

const emptyDraft: Draft = { username: "", displayName: "", password: "", role: "staff" }

/** Administrator-only screen: who may sign in and how. */
export default function UsersPage() {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pinFor, setPinFor] = useState<ManagedUser | null>(null)
  const [pin, setPin] = useState("")
  const [deviceName, setDeviceName] = useState("")

  const { data: users, isLoading } = useListUsers()
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() })

  const reportError = (error: ApiError | null | undefined, fallback: string) => {
    const message = error?.data
    toast.error(
      message && typeof message === "object" && "error" in message
        ? String((message as { error?: unknown }).error)
        : fallback,
    )
  }

  const { mutate: createUser, isPending: isCreating } = useCreateUser({
    mutation: {
      onSuccess: () => {
        toast.success("Сотрудник создан")
        setDraft(null)
        refresh()
      },
      onError: (error) => reportError(error, "Не удалось создать сотрудника"),
    },
  })

  const { mutate: updateUser, isPending: isUpdating } = useUpdateUser({
    mutation: {
      onSuccess: () => {
        toast.success("Сохранено")
        setDraft(null)
        setPinFor(null)
        setPin("")
        refresh()
      },
      onError: (error) => reportError(error, "Не удалось сохранить"),
    },
  })

  const { mutate: revokeDevices, isPending: isRevoking } = useRevokeUserDevices({
    mutation: {
      onSuccess: () => {
        toast.success("Доступ отозван: устройства и сессии закрыты")
        refresh()
      },
      onError: (error) => reportError(error, "Не удалось отозвать доступ"),
    },
  })

  const { mutate: trustDevice, isPending: isTrusting } = useTrustCurrentDevice({
    mutation: {
      onSuccess: (device) => {
        toast.success(`Устройство «${device.name}» доверено`)
        setDeviceName("")
        refresh()
      },
      onError: (error) => reportError(error, "Не удалось доверить устройство"),
    },
  })

  // Messenger access: the code is issued by the bot and typed here.
  const [linkCode, setLinkCode] = useState("")
  const { data: links } = useListChannelLinks()
  const { mutate: claimCode, isPending: isClaiming } = useClaimChannelLink({
    mutation: {
      onSuccess: (result) => {
        toast.success(`Мессенджер привязан: ${result.channel}`)
        setLinkCode("")
        queryClient.invalidateQueries({ queryKey: getListChannelLinksQueryKey() })
        refresh()
      },
      onError: (error) => reportError(error, "Не удалось привязать мессенджер"),
    },
  })
  const { mutate: unlinkChannel } = useUnlinkChannel({
    mutation: {
      onSuccess: () => {
        toast.success("Доступ мессенджера отозван")
        queryClient.invalidateQueries({ queryKey: getListChannelLinksQueryKey() })
      },
      onError: (error) => reportError(error, "Не удалось отозвать доступ"),
    },
  })

  const submitDraft = () => {
    if (!draft) return
    if (draft.id) {
      updateUser({
        id: draft.id,
        data: {
          displayName: draft.displayName.trim(),
          role: draft.role,
          ...(draft.password ? { password: draft.password } : {}),
        },
      })
      return
    }
    createUser({
      data: {
        username: draft.username.trim(),
        displayName: draft.displayName.trim(),
        password: draft.password,
        role: draft.role,
      },
    })
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
            Сотрудники
          </h1>
          <p className="text-muted-foreground mt-1">
            Кто может входить в систему и что ему разрешено
          </p>
        </div>
        <Button className="h-11 md:h-10" onClick={() => setDraft({ ...emptyDraft })}>
          <UserPlus className="mr-2 h-4 w-4" />
          Добавить сотрудника
        </Button>
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="device-name">Доверенное устройство склада</Label>
            <Input
              id="device-name"
              placeholder="Например: планшет склада"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
            />
          </div>
          <Button
            className="h-11 md:h-10"
            disabled={isTrusting || !deviceName.trim()}
            onClick={() => trustDevice({ data: { name: deviceName.trim() } })}
          >
            <Smartphone className="mr-2 h-4 w-4" />
            Доверить этот браузер
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          На доверенном устройстве сотрудник входит по PIN, не набирая пароль. Доверие выдаётся
          вашей учётной записью и отзывается кнопкой «Отозвать доступ».
        </p>
      </Card>

      {/* Messengers run the same assistant, so a linked account is a way in. */}
      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">Мессенджеры</span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="link-code">Код из мессенджера</Label>
            <Input
              id="link-code"
              placeholder="Например: EBWFJA5O"
              autoCapitalize="characters"
              value={linkCode}
              onChange={(event) => setLinkCode(event.target.value.toUpperCase())}
            />
          </div>
          <Button
            className="h-11 md:h-10"
            disabled={isClaiming || linkCode.trim().length < 4}
            onClick={() => claimCode({ data: { code: linkCode.trim() } })}
          >
            <Link2 className="mr-2 h-4 w-4" />
            Привязать к моей учётной записи
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Напишите боту склада в Telegram или MAX — он ответит кодом. Код действует 30 минут и
          привязывает аккаунт к той учётной записи, под которой вы сейчас вошли.
        </p>

        {(links ?? []).length > 0 && (
          <div className="mt-3 space-y-2 border-t pt-3">
            {(links ?? []).map((link) => (
              <div
                key={link.id}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <div className="min-w-0">
                  <span className="font-medium">
                    {link.channel === "telegram" ? "Telegram" : "MAX"}
                  </span>
                  <span className="ml-2 text-muted-foreground">
                    {link.displayName ?? link.username ?? link.externalId}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    → {link.userDisplayName}
                  </span>
                </div>
                <Button
                  variant="outline"
                  className="h-11 text-destructive md:h-9"
                  onClick={() => unlinkChannel({ id: link.id })}
                >
                  Отозвать
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {isLoading ? (
        <div className="rounded-xl border bg-card py-12 text-center text-muted-foreground">
          Загрузка...
        </div>
      ) : (
        <div className="space-y-3">
          {(users ?? []).map((user) => (
            <Card key={user.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{user.displayName}</span>
                    <span className="text-sm text-muted-foreground">{user.username}</span>
                    {user.role === "admin" && (
                      <Badge variant="secondary" className="gap-1 bg-primary/10 text-primary">
                        <ShieldCheck className="h-3 w-3" />
                        администратор
                      </Badge>
                    )}
                    {!user.isActive && <Badge variant="destructive">отключён</Badge>}
                    {user.isProtected && <Badge variant="outline">основной</Badge>}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {user.hasPin ? "PIN задан · " : "PIN не задан · "}
                    устройств: {user.deviceCount} · сессий: {user.sessionCount}
                    {user.lastLoginAt ? ` · вход: ${formatDateTime(user.lastLoginAt)}` : ""}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    className="h-11 md:h-10"
                    onClick={() => setPinFor(user)}
                  >
                    <KeyRound className="mr-2 h-4 w-4" />
                    PIN
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 md:h-10"
                    onClick={() =>
                      setDraft({
                        id: user.id,
                        username: user.username,
                        displayName: user.displayName,
                        password: "",
                        role: user.role,
                      })
                    }
                  >
                    Изменить
                  </Button>
                  {!user.isProtected && (
                    <Button
                      variant="outline"
                      className="h-11 md:h-10"
                      disabled={isRevoking || !user.isActive}
                      onClick={() => updateUser({ id: user.id, data: { isActive: !user.isActive } })}
                    >
                      {user.isActive ? "Отключить" : "Включить"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    className="h-11 text-destructive md:h-10"
                    disabled={isRevoking}
                    onClick={() => revokeDevices({ id: user.id })}
                  >
                    Отозвать доступ
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create or edit */}
      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Изменить сотрудника" : "Новый сотрудник"}</DialogTitle>
            <DialogDescription>
              {draft?.id
                ? "Смена пароля завершит все его сессии, включая вход по PIN."
                : "Пароль задаёте вы — восстановления по почте в системе нет."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {!draft?.id && (
              <div className="space-y-1.5">
                <Label htmlFor="new-username">Логин</Label>
                <Input
                  id="new-username"
                  autoCapitalize="none"
                  value={draft?.username ?? ""}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, username: event.target.value } : current))
                  }
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="new-display-name">Имя</Label>
              <Input
                id="new-display-name"
                value={draft?.displayName ?? ""}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, displayName: event.target.value } : current,
                  )
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password">
                {draft?.id ? "Новый пароль (оставьте пустым, чтобы не менять)" : "Пароль"}
              </Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={draft?.password ?? ""}
                onChange={(event) =>
                  setDraft((current) => (current ? { ...current, password: event.target.value } : current))
                }
              />
              <p className="text-xs text-muted-foreground">
                Не короче 8 символов, хотя бы одна буква и одна цифра.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Роль</Label>
              <Select
                value={draft?.role ?? "staff"}
                onValueChange={(value) =>
                  setDraft((current) =>
                    current ? { ...current, role: value as "admin" | "staff" } : current,
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="staff">Сотрудник — только операции</SelectItem>
                  <SelectItem value="admin">Администратор — полный доступ</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Отмена
            </Button>
            <Button
              onClick={submitDraft}
              disabled={isCreating || isUpdating || !draft?.displayName.trim()}
            >
              {(isCreating || isUpdating) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PIN */}
      <Dialog open={pinFor !== null} onOpenChange={(open) => !open && setPinFor(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>PIN для {pinFor?.displayName}</DialogTitle>
            <DialogDescription>
              Четыре цифры для входа на доверенном устройстве. Пустое поле снимет PIN.
            </DialogDescription>
          </DialogHeader>
          <Input
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            placeholder="0000"
            className="text-center text-2xl tracking-[0.5em]"
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/gu, ""))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPinFor(null)}>
              Отмена
            </Button>
            <Button
              disabled={isUpdating}
              onClick={() =>
                pinFor && updateUser({ id: pinFor.id, data: { pin: pin || null } })
              }
            >
              {isUpdating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Сохранить PIN
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
