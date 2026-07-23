<script setup lang="ts">
import { X } from "@lucide/vue"
import { useToastStore } from "@/stores/toast"
import { cn } from "@/lib/utils"

const toast = useToastStore()

// A left accent bar per kind — avoids depending on specific lucide icon names.
const kindClass: Record<string, string> = {
  success: "border-l-4 border-l-green-500",
  error: "border-l-4 border-l-destructive",
  info: "border-l-4 border-l-primary",
}
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end"
      role="region"
      aria-label="Notifications"
      data-slot="toaster"
    >
      <TransitionGroup
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="translate-y-2 opacity-0"
        enter-to-class="translate-y-0 opacity-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div
          v-for="t in toast.toasts"
          :key="t.id"
          role="alert"
          :class="
            cn(
              'bg-card text-card-foreground border-border-strong shadow-card pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border p-3 text-sm',
              kindClass[t.kind],
            )
          "
        >
          <span class="flex-1">{{ t.message }}</span>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
            aria-label="Dismiss"
            @click="toast.dismiss(t.id)"
          >
            <X class="size-4" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
