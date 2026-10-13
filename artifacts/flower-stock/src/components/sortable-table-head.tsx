import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import { TableHead } from "@/components/ui/table"

type Props = {
  label: string
  active: boolean
  direction: "asc" | "desc"
  onClick: () => void
  className?: string
}

export function SortableTableHead({
  label,
  active,
  direction,
  onClick,
  className,
}: Props) {
  const Icon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown

  return (
    <TableHead
      className={className}
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={onClick}
        // Tall enough to tap on a tablet/phone; the desktop height is restored
        // at `md` so the table keeps its compact rows.
        className={`inline-flex min-h-11 w-full items-center gap-1.5 rounded-sm py-2 font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0 ${
          className?.includes("text-right") ? "justify-end" : "justify-start"
        }`}
      >
        {label}
        <Icon className={`h-3.5 w-3.5 ${active ? "text-primary" : "text-muted-foreground/60"}`} />
      </button>
    </TableHead>
  )
}