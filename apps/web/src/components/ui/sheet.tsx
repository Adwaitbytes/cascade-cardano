"use client";

import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Side drawer on wide screens, bottom sheet on phones. */
export function Sheet({ open, onOpenChange, title, description, children, className, modal = true }: { modal?: boolean; open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <Dialog.Portal>
        {modal ? <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" /> : null}
        <Dialog.Content
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden border-line bg-surface shadow-pop focus-visible:outline-none",
            "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-2xl border-t data-[state=open]:animate-[sheet-up_260ms_var(--ease-out-quint)]",
            "sm:inset-y-3 sm:right-3 sm:left-auto sm:max-h-none sm:w-[min(560px,calc(100vw-24px))] sm:rounded-2xl sm:border sm:data-[state=open]:animate-[sheet-in_260ms_var(--ease-out-quint)]",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold tracking-tight">{title}</Dialog.Title>
              {description ? <Dialog.Description className="mt-0.5 text-[0.8125rem] text-ink-3">{description}</Dialog.Description> : <Dialog.Description className="sr-only">Details</Dialog.Description>}
            </div>
            <Dialog.Close className="-mr-1 rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
