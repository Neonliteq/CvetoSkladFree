import { useState, useRef, useEffect, useMemo } from "react"
import {
  getGetDashboardQueryKey,
  getGetMovementAnalyticsQueryKey,
  getListBouquetsQueryKey,
  getListMovementsQueryKey,
  getListProductsQueryKey,
  getGetAssistantConversationQueryKey,
  useApplyAssistantCommandPlan,
  useApplyInvoice,
  useClearAssistantConversation,
  useGetAssistantConversation,
  useListProducts,
  useRecognizeInvoice,
  useRunAssistantCommand,
  useUndoAssistantBatch,
  useUndoAssistantOperation,
} from "@workspace/api-client-react"
import type {
  AssistantClarification,
  AssistantClarificationOption,
  AssistantPlan,
  InvoiceDraftItem,
  InvoiceRecognition,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Send, Sparkles, User, Bot, RotateCcw, Undo2, ImagePlus, Loader2, Check, Mic, MicOff, Camera } from "lucide-react"
import { toast } from "sonner"
import {
  getOrCreateConversationId,
  retainLatestUndoAction,
  replaceConversationId,
  restoreAssistantMessages,
} from "@/lib/assistant-state"
import { useVoiceInput } from "@/hooks/use-voice-input"
import { InvoiceDraftCard } from "./invoice-draft-card"
import { AssistantPlanCard, type PlanReviewState } from "./assistant-plan-card"

type Message = {
  id: string
  role: "user" | "assistant"
  content: string
  action?: string
  operationId?: number
  canUndo?: boolean
  suggestions?: string[]
  invoiceDraft?: InvoiceRecognition
  invoiceReview?: { status: "pending" | "applied"; appliedCount?: number | null }
  imagePreview?: string
  /** Breakdown of a composite command; nothing is written while it is shown. */
  plan?: AssistantPlan
  /** What happened to that breakdown, including the id that reverts the set. */
  planReview?: PlanReviewState
}

const INITIAL_SUGGESTIONS = [
  "Пришло 50 красных роз Freedom по 80 руб",
  "Спиши 5 увядших пионов",
  "Покажи товары, которые заканчиваются",
  "Какие поставки скоро испортятся?",
]

const WELCOME_MESSAGE: Message = {
  id: "init",
  role: "assistant",
  content: "Привет! Я помню контекст этого диалога. Можно уточнять предыдущую просьбу короткими фразами — например, «да, этот товар» или «добавь ещё 10».",
  suggestions: INITIAL_SUGGESTIONS,
}

const ACTION_LABELS: Record<string, string> = {
  receipt_created: "Приход",
  expense_created: "Расход",
  writeoff_created: "Списание",
  assembly_created: "Передано в сборку",
  stock_adjusted: "Корректировка остатка",
  product_updated: "Товар изменён",
  receipt_updated: "Приход изменён",
  operation_undone: "Операция отменена",
  invoice_recognized: "Накладная распознана",
  invoice_receipt_created: "Приход по накладной",
  plan_preview: "Разбор команды",
  batch_undone: "Набор операций отменён",
}

const actionLabel = (action: string) => ACTION_LABELS[action] ?? action

const createConversationId = () =>
  globalThis.crypto?.randomUUID?.() ?? `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`

export default function AssistantPage() {
  const [input, setInput] = useState("")
  const [applyingDraftId, setApplyingDraftId] = useState<string | null>(null)
  // The card that is currently being written or reverted; the ref carries the
  // target into the mutation callbacks, the state only drives the spinner.
  const [applyingPlanId, setApplyingPlanId] = useState<string | null>(null)
  const [undoingBatchId, setUndoingBatchId] = useState<string | null>(null)
  const applyingPlanRef = useRef<string | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const userTypedRef = useRef(false)
  const [conversationId, setConversationId] = useState(() => {
    return getOrCreateConversationId(localStorage, createConversationId)
  })
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE])
  const scrollRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()
  const { data: conversation, isLoading: isHistoryLoading } = useGetAssistantConversation(
    conversationId,
    {
      query: {
        queryKey: getGetAssistantConversationQueryKey(conversationId),
      },
    },
  )
  // Only stock products can receive a delivery note.
  const { data: allProducts } = useListProducts()
  const stockProducts = useMemo(
    () => (allProducts ?? []).filter((product) => product.productType === "stock"),
    [allProducts],
  )
  const { mutate: clearConversation, isPending: isClearing } = useClearAssistantConversation()

  // Dictation only fills the input field; sending the command stays manual so a
  // misheard word cannot post a wrong stock movement on its own.
  const voice = useVoiceInput({
    onTranscript: (text) => setInput(text),
  })

  useEffect(() => {
    if (voice.error) toast.error(voice.error)
  }, [voice.error])

  const invalidateInventory = () => {
    queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
    queryClient.invalidateQueries({ queryKey: getListMovementsQueryKey() })
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() })
    queryClient.invalidateQueries({ queryKey: getGetMovementAnalyticsQueryKey() })
    queryClient.invalidateQueries({ queryKey: getListBouquetsQueryKey() })
  }

  useEffect(() => {
    if (!conversation) return
    setMessages(conversation.messages.length
      ? restoreAssistantMessages(conversation.messages) as unknown as Message[]
      : [WELCOME_MESSAGE])
  }, [conversation])

  const { mutate: runCommand, isPending } = useRunAssistantCommand({
    mutation: {
      onSuccess: (res) => {
        // A breakdown writes nothing, so the inventory is still correct and the
        // cache is left alone until the user confirms it.
        const preview = res.action === "plan_preview" && res.plan ? res.plan : null
        if (!preview && res.action !== "answered" && res.action !== "unknown") {
          invalidateInventory()
        }
        setMessages(prev => [
          ...retainLatestUndoAction(prev, res.operationId),
          {
            id: Date.now().toString(),
            role: "assistant",
            content: res.answer,
            action: res.action,
            operationId: res.operationId ?? undefined,
            canUndo: res.canUndo ?? false,
            suggestions: res.suggestions?.length > 0 ? res.suggestions : INITIAL_SUGGESTIONS,
            ...(preview
              ? {
                  plan: preview,
                  planReview: {
                    status: "pending" as const,
                    batchId: null,
                    appliedCount: 0,
                    errors: res.errors ?? [],
                  },
                }
              : {}),
          },
        ])
      },
      onError: (error: any) => {
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          role: "assistant",
          content: error?.data?.error || "Извини, произошла ошибка связи с сервером. Попробуй еще раз.",
        }])
      }
    }
  })

  /**
   * Возвращает курсор в поле ввода после ответа ассистента.
   *
   * Раньше поле блокировалось на время запроса, фокус с него снимался, и для
   * следующей команды приходилось щёлкать мышью. Теперь поле остаётся активным,
   * а фокус возвращается явно — если его увели кликом по ответу. Возврат только
   * после того, как пользователь сам что-то отправил: иначе на телефоне
   * клавиатура выскакивала бы при открытии раздела.
   */
  useEffect(() => {
    if (!isPending && userTypedRef.current) inputRef.current?.focus()
  }, [isPending])

  const { mutate: undoOperation, isPending: isUndoing } = useUndoAssistantOperation({
    mutation: {
      onSuccess: (res, variables) => {
        setMessages((previous) => [
          ...previous.map((message) =>
            message.operationId === variables.movementId
              ? { ...message, canUndo: false }
              : message,
          ),
          {
            id: Date.now().toString(),
            role: "assistant",
            content: res.answer,
            action: res.action,
          },
        ])
        invalidateInventory()
        queryClient.invalidateQueries({
          queryKey: getGetAssistantConversationQueryKey(conversationId),
        })
      },
      onError: (error: any) => {
        toast.error(error?.data?.error || "Не удалось отменить операцию")
      },
    },
  })

  // Writes a confirmed breakdown. The whole set goes in one call, so it is also
  // the path a doubtful position takes once the user taps a product option.
  const { mutate: applyCommandPlan } = useApplyAssistantCommandPlan({
    mutation: {
      onSuccess: (res) => {
        const targetId = applyingPlanRef.current
        invalidateInventory()
        setMessages((previous) =>
          previous.map((message) => {
            if (message.id !== targetId) return message
            const planReview: PlanReviewState = {
              status: "applied",
              batchId: res.batchId,
              appliedCount: res.appliedCount,
              errors: res.errors ?? [],
              answer: res.answer,
            }
            return { ...message, planReview }
          }),
        )
        if (res.errors?.length) {
          toast.error("Часть позиций не проведена — смотрите разбор команды")
        } else {
          toast.success(`Проведено позиций: ${res.appliedCount}`)
        }
      },
      onError: (error: any) => {
        toast.error(error?.data?.error || "Не удалось провести разбор команды")
        // The breakdown stays on screen, so the user can fix the position and
        // confirm the same card again.
      },
      onSettled: () => {
        applyingPlanRef.current = null
        setApplyingPlanId(null)
      },
    },
  })

  const { mutate: undoBatch } = useUndoAssistantBatch({
    mutation: {
      onSuccess: (res, variables) => {
        invalidateInventory()
        setMessages((previous) => [
          ...previous.map((message): Message => {
            const review = message.planReview
            if (!review || review.batchId !== variables.batchId) return message
            return { ...message, planReview: { ...review, status: "undone" } }
          }),
          {
            id: Date.now().toString(),
            role: "assistant",
            content: res.answer,
            action: res.action,
            suggestions: res.suggestions?.length > 0 ? res.suggestions : INITIAL_SUGGESTIONS,
          },
        ])
      },
      onError: (error: any) => {
        toast.error(error?.data?.error || "Не удалось отменить набор операций")
      },
      onSettled: () => {
        setUndoingBatchId(null)
      },
    },
  })

  const requestPlanApply = (messageId: string, plan: AssistantPlan) => {
    applyingPlanRef.current = messageId
    setApplyingPlanId(messageId)
    applyCommandPlan({ data: { conversationId, plan } })
  }

  /** Tapping an option replaces the doubtful position with the picked product. */
  const selectClarificationOption = (
    message: Message,
    clarification: AssistantClarification,
    option: AssistantClarificationOption,
  ) => {
    if (!message.plan) return
    const plan: AssistantPlan = {
      operations: message.plan.operations,
      clarifications: message.plan.clarifications.map((item) =>
        item.index === clarification.index ? { ...item, selectedProductId: option.id } : item,
      ),
    }
    // Keeping the choice on the card lets it show which product was picked once
    // the set is written.
    setMessages((previous) =>
      previous.map((entry) => (entry.id === message.id ? { ...entry, plan } : entry)),
    )
    requestPlanApply(message.id, plan)
  }

  const requestBatchUndo = (batchId: string) => {
    setUndoingBatchId(batchId)
    undoBatch({ batchId, data: { conversationId } })
  }

  const { mutate: recognizeInvoice, isPending: isRecognizing } = useRecognizeInvoice({
    mutation: {
      onSuccess: () => {
        invalidateInventory()
        queryClient.invalidateQueries({
          queryKey: getGetAssistantConversationQueryKey(conversationId),
        })
      },
      onError: (error: any) => {
        toast.error(error?.data?.error || "Не удалось распознать накладную")
      },
    },
  })

  const { mutate: applyInvoice } = useApplyInvoice({
    mutation: {
      onSuccess: (res) => {
        toast.success(`${res.answer}`)
        invalidateInventory()
        queryClient.invalidateQueries({
          queryKey: getGetAssistantConversationQueryKey(conversationId),
        })
      },
      onError: (error: any) => {
        toast.error(error?.data?.error || "Не удалось провести приход")
      },
      onSettled: () => setApplyingDraftId(null),
    },
  })

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isPending])

  const handleSend = (text: string) => {
    if (!text.trim()) return
    // Запоминаем, что пользователь работает с полем: только тогда возвращаем
    // фокус после ответа, чтобы на телефоне не выскакивала клавиатура сама.
    userTypedRef.current = true

    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: "user",
      content: text
    }])
    setInput("")
    
    runCommand({ data: { message: text, conversationId } })
  }

  const maxPhotoBytes = 8 * 1024 * 1024

  /**
   * Downscales the photo for the conversation history. The full-size image is
   * only used for recognition, so storing a small copy keeps the dialog light
   * while still showing which document was processed.
   */
  const makeThumbnail = (dataUrl: string, maxSide = 360) =>
    new Promise<string | null>((resolve) => {
      const image = new Image()
      image.onload = () => {
        try {
          const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
          const canvas = document.createElement("canvas")
          canvas.width = Math.max(1, Math.round(image.width * scale))
          canvas.height = Math.max(1, Math.round(image.height * scale))
          const context = canvas.getContext("2d")
          if (!context) {
            resolve(null)
            return
          }
          context.drawImage(image, 0, 0, canvas.width, canvas.height)
          resolve(canvas.toDataURL("image/jpeg", 0.7))
        } catch {
          resolve(null)
        }
      }
      image.onerror = () => resolve(null)
      image.src = dataUrl
    })

  const handleInvoicePhoto = (file: File) => {
    if (!/^image\/(jpeg|png|gif|webp)$/u.test(file.type)) {
      toast.error("Поддерживаются JPEG, PNG, GIF и WebP")
      return
    }
    if (file.size > maxPhotoBytes) {
      toast.error(`Фото больше ${maxPhotoBytes / 1024 / 1024} МБ — сожмите его и попробуйте снова`)
      return
    }
    const reader = new FileReader()
    reader.onerror = () => toast.error("Не удалось прочитать файл")
    reader.onload = async () => {
      const imageDataUrl = String(reader.result ?? "")
      if (!imageDataUrl.startsWith("data:image/")) {
        toast.error("Не удалось прочитать изображение")
        return
      }
      const thumbnailDataUrl = await makeThumbnail(imageDataUrl)
      // Shown immediately so the user sees which document is being processed;
      // the conversation itself only stores the recognised draft.
      setMessages(prev => [...prev, {
        id: `photo-${Date.now()}`,
        role: "user",
        content: `Фото накладной: ${file.name}`,
        imagePreview: thumbnailDataUrl ?? imageDataUrl,
      }])
      recognizeInvoice({
        data: { conversationId, imageDataUrl, thumbnailDataUrl: thumbnailDataUrl ?? null },
      })
    }
    reader.readAsDataURL(file)
  }

  const startNewConversation = () => {
    clearConversation(
      { conversationId },
      {
        onSettled: () => {
          const nextId = replaceConversationId(localStorage, createConversationId)
          setConversationId(nextId)
          setMessages([WELCOME_MESSAGE])
          setInput("")
        },
      },
    )
  }

  return (
    // The chat fills the space the layout gives it instead of subtracting a
    // fixed 6rem: on a phone every reclaimed pixel is a visible message.
    <div className="flex h-[calc(100dvh-9.5rem)] flex-col animate-in fade-in slide-in-from-bottom-4 duration-500 md:h-[calc(100vh-6rem)]">
      <div className="mb-2 flex items-center justify-between gap-2 md:mb-6 md:items-start md:gap-4">
        <div className="min-w-0">
          {/* The mobile top bar already names the section, so repeating it here
              would only cost a row of the chat. */}
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-foreground md:gap-3 md:text-3xl">
            <Sparkles className="hidden h-6 w-6 shrink-0 text-primary md:block md:h-8 md:w-8" />
            <span className="truncate">AI Ассистент</span>
          </h1>
          <p className="mt-1 hidden text-muted-foreground md:block">
            Управляй складом на естественном языке
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-11 min-w-11 shrink-0 px-3 md:h-10 md:min-w-0 md:px-4"
          aria-label="Новый диалог"
          title="Новый диалог"
          onClick={startNewConversation}
          disabled={isPending || isClearing}
        >
          <RotateCcw className="h-4 w-4 md:mr-2" />
          <span className="hidden md:inline">Новый диалог</span>
        </Button>
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden bg-card/50 backdrop-blur border-primary/10 shadow-lg">
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-3 sm:p-4 md:space-y-6 md:p-6">
          {isHistoryLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Загружаем историю диалога...</p>
          ) : messages.map((msg) => (
            <div 
              key={msg.id} 
              className={`flex w-full gap-2 md:gap-4 ${
                msg.invoiceDraft || msg.plan ? "max-w-full md:max-w-[95%]" : "max-w-full md:max-w-[85%]"
              } ${msg.role === 'user' ? 'ml-auto flex-row-reverse' : ''}`}
            >
              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full md:h-8 md:w-8 ${
                msg.role === 'user' 
                  ? 'bg-primary text-primary-foreground' 
                  : 'bg-sidebar text-sidebar-foreground'
              }`}>
                {msg.role === 'user' ? <User className="h-3.5 w-3.5 md:h-4 md:w-4" /> : <Bot className="h-3.5 w-3.5 md:h-4 md:w-4" />}
              </div>
              
              <div className={`flex min-w-0 flex-col gap-2 ${msg.role === 'user' ? 'items-end' : 'items-start'} ${
                msg.invoiceDraft || msg.plan ? "flex-1" : ""
              }`}>
                <div className={`px-3 py-2.5 rounded-2xl md:px-4 md:py-3 ${
                  msg.role === 'user' 
                    ? 'bg-primary text-primary-foreground rounded-tr-sm' 
                    : 'bg-card border shadow-sm rounded-tl-sm'
                }`}>
                  {msg.imagePreview && (
                    <img
                      src={msg.imagePreview}
                      alt="Фото накладной"
                      className="mb-2 max-h-40 rounded-lg border border-white/20 bg-white/5 object-contain"
                    />
                  )}
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                </div>

                {msg.invoiceDraft && (
                  <InvoiceDraftCard
                    draft={msg.invoiceDraft}
                    products={stockProducts}
                    status={msg.invoiceReview?.status ?? "pending"}
                    appliedCount={msg.invoiceReview?.appliedCount ?? null}
                    isApplying={applyingDraftId === msg.id}
                    onApply={(lines) => {
                      setApplyingDraftId(msg.id)
                      applyInvoice({
                        data: {
                          conversationId,
                          supplierName: msg.invoiceDraft?.supplierName ?? null,
                          invoiceNumber: msg.invoiceDraft?.invoiceNumber ?? null,
                          invoiceDate: msg.invoiceDraft?.invoiceDate ?? null,
                          items: lines,
                        },
                      })
                    }}
                  />
                )}
                
                {msg.plan && msg.planReview && (
                  <AssistantPlanCard
                    plan={msg.plan}
                    review={msg.planReview}
                    isApplying={applyingPlanId === msg.id}
                    isUndoing={undoingBatchId === msg.planReview.batchId}
                    onApply={(plan) => requestPlanApply(msg.id, plan)}
                    onSelectOption={(clarification, option) =>
                      selectClarificationOption(msg, clarification, option)
                    }
                    onUndoBatch={requestBatchUndo}
                  />
                )}

                {/* The review cards already state their status, so the generic
                    action badge would only duplicate it. */}
                {msg.action && msg.action !== 'unknown' && msg.action !== 'answered' && !msg.invoiceDraft && !msg.invoiceReview && !msg.plan && (
                  <Badge variant="secondary" className="flex items-center gap-1.5 text-xs bg-green-500/10 text-green-700 hover:bg-green-500/20 border-0">
                    {actionLabel(msg.action)}
                  </Badge>
                )}

                {msg.canUndo && msg.operationId && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isPending || isUndoing}
                    onClick={() =>
                      undoOperation({
                        movementId: msg.operationId!,
                        data: { conversationId },
                      })
                    }
                  >
                    <Undo2 className="mr-2 h-3.5 w-3.5" />
                    {isUndoing
                      ? "Отменяем..."
                      : msg.action === "invoice_receipt_created"
                        ? "Отменить эту строку"
                        : "Отменить"}
                  </Button>
                )}

                {msg.suggestions && msg.role === 'assistant' && msg.id === messages[messages.length - 1].id && (
                  // On a phone the chips used to stack into four rows; a single
                  // swipeable line keeps the conversation visible behind them.
                  <div className="-mx-1 mt-1 flex w-[calc(100%+0.5rem)] snap-x gap-2 overflow-x-auto px-1 pb-1 md:mx-0 md:mt-2 md:w-auto md:flex-wrap md:overflow-visible md:pb-0">
                    {msg.suggestions.map((sug, i) => (
                      <button
                        key={i}
                        onClick={() => handleSend(sug)}
                        className="flex min-h-11 shrink-0 snap-start items-center whitespace-nowrap rounded-full bg-accent px-4 text-xs text-accent-foreground transition-colors hover:bg-accent/80 md:min-h-0 md:whitespace-normal md:py-1.5"
                      >
                        {sug}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {isPending && (
            // A composite command takes several seconds to break down, so the
            // waiting bubble names the step instead of showing dots alone.
            <div className="flex gap-4 max-w-[85%]" role="status" aria-live="polite">
               <div className="shrink-0 w-8 h-8 rounded-full bg-sidebar text-sidebar-foreground flex items-center justify-center">
                <Bot className="h-4 w-4" />
              </div>
              <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border bg-card px-4 py-3 shadow-sm">
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 bg-primary/40 rounded-full animate-bounce" />
                  <div className="w-2 h-2 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 bg-primary/80 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-sm text-muted-foreground">Разбираю команду...</span>
              </div>
            </div>
          )}
          {isRecognizing && (
            <div className="flex gap-4 max-w-[85%]">
              <div className="shrink-0 w-8 h-8 rounded-full bg-sidebar text-sidebar-foreground flex items-center justify-center">
                <Bot className="h-4 w-4" />
              </div>
              <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Распознаю накладную и сверяю с каталогом...
              </div>
            </div>
          )}
        </div>
        
        <div className="mt-auto border-t bg-card p-2 sm:p-3 md:p-4">
          <form 
            onSubmit={(e) => {
              e.preventDefault();
              // Поле больше не блокируется на время запроса, поэтому защищаемся
              // от повторной отправки здесь.
              if (isPending) return;
              handleSend(input);
            }} 
            className="relative flex items-center gap-1.5 md:gap-2"
          >
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) handleInvoicePhoto(file)
                event.target.value = ""
              }}
            />
            {/* On a phone the invoice is photographed on the spot, so the camera
                gets its own button instead of hiding behind the gallery picker. */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) handleInvoicePhoto(file)
                event.target.value = ""
              }}
            />
            {voice.isSupported && (
              <Button
                type="button"
                variant={voice.isListening ? "default" : "outline"}
                size="icon"
                className={`h-11 w-11 shrink-0 rounded-xl md:h-12 md:w-12 ${
                  voice.isListening ? "animate-pulse ring-2 ring-primary/40" : ""
                }`}
                title={
                  voice.isListening
                    ? "Остановить диктовку"
                    : "Продиктовать команду голосом"
                }
                aria-label={
                  voice.isListening
                    ? "Остановить голосовой ввод"
                    : "Начать голосовой ввод"
                }
                aria-pressed={voice.isListening}
                disabled={isPending || isRecognizing}
                onClick={() => voice.toggle(input)}
              >
                {voice.isListening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              </Button>
            )}
            {/* One button, two sources: on a phone the invoice is photographed on
                the spot, on a desktop it is usually already in a file. Keeping
                both behind one trigger leaves room for the text field. */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 shrink-0 rounded-xl sm:h-12 sm:w-12"
                  title="Фото накладной"
                  aria-label="Приложить фото накладной"
                  disabled={isRecognizing || isPending}
                >
                  <ImagePlus className="h-5 w-5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-60 p-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm hover:bg-accent md:hidden"
                  onClick={() => cameraInputRef.current?.click()}
                >
                  <Camera className="h-4 w-4 shrink-0 text-muted-foreground" />
                  Сфотографировать
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm hover:bg-accent"
                  onClick={() => imageInputRef.current?.click()}
                >
                  <ImagePlus className="h-4 w-4 shrink-0 text-muted-foreground" />
                  Выбрать из галереи
                </button>
              </PopoverContent>
            </Popover>
            <div className="relative flex-1">
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  voice.isListening
                    ? "Говорите — текст появится здесь..."
                    : "Напишите, продиктуйте или приложите фото накладной"
                }
                className={`pr-14 md:pr-12 bg-background focus-visible:ring-primary/30 h-11 rounded-xl text-base sm:h-12 md:text-sm ${
                  voice.isListening ? "border-primary/60" : "border-primary/20"
                }`}
              />
              <Button 
                type="submit" 
                size="icon" 
                className="absolute right-1.5 top-1.5 h-11 w-11 rounded-lg md:right-1.5 md:top-1.5 md:h-9 md:w-9"
                aria-label="Отправить команду"
                disabled={!input.trim() || isPending}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </form>
          {/* The hint repeats the placeholder on a phone, so it is desktop-only. */}
          <p className="mt-2 hidden text-xs text-muted-foreground md:block">
            {voice.isListening
              ? "Идёт запись. Распознанный текст можно поправить перед отправкой."
              : "Можно написать, продиктовать голосом или приложить фото накладной — ассистент сверит позиции с каталогом."}
          </p>
        </div>
      </Card>
    </div>
  )
}
