<script setup lang="ts">
import { computed } from 'vue'
import { Check, ChevronsUpDown, Cpu } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatUSD } from '@/lib/format'
import { MODELS } from '@/lib/models'

const modelId = defineModel<string>({ required: true })

const selected = computed(() => MODELS.find((model) => model.id === modelId.value) ?? MODELS[0]!)
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="secondary"
        class="bg-muted hover:border-border-strong hover:bg-muted h-9 gap-2 border px-3"
      >
        <Cpu class="text-link size-3.5" />
        <span class="text-muted-foreground text-xs">Model</span>
        <span class="font-mono text-xs">{{ selected.name }}</span>
        <ChevronsUpDown class="text-muted-foreground size-3.5" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      side="top"
      align="start"
      :side-offset="8"
      class="bg-card border-border-strong shadow-card w-90 rounded-xl p-1.5"
    >
      <DropdownMenuLabel
        class="text-muted-foreground px-2.5 pt-1.5 pb-1 text-xs font-medium tracking-wider uppercase"
      >
        Select model
      </DropdownMenuLabel>
      <DropdownMenuItem
        v-for="model in MODELS"
        :key="model.id"
        role="menuitemradio"
        :aria-checked="model.id === modelId"
        class="flex cursor-pointer flex-col items-start gap-1.5 rounded-lg px-2.5 py-2.5"
        :class="model.id === modelId && 'bg-primary/10'"
        @select="modelId = model.id"
      >
        <div class="flex w-full items-center gap-2">
          <span class="font-mono text-xs font-medium">{{ model.name }}</span>
          <span
            v-if="model.recommended"
            class="rounded-full border border-green-500/25 bg-green-500/10 px-1.5 py-px text-[10px] font-medium text-green-500"
          >
            Recommended
          </span>
          <Check v-if="model.id === modelId" class="text-link ml-auto size-3.5" />
        </div>
        <div class="text-muted-foreground text-xs">Best for {{ model.bestFor }}</div>
        <div class="flex w-full items-center justify-between">
          <span class="text-link font-mono text-xs">
            {{ formatUSD(model.pricePerMillionTokensCents) }} per 1M tokens
          </span>
          <span class="text-muted-foreground font-mono text-xs">
            {{ model.contextWindow }} context
          </span>
        </div>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
