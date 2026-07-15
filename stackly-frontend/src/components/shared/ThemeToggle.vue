<script setup lang="ts">
import { Moon, Sun } from '@lucide/vue'
import { Button, type ButtonVariants } from '@/components/ui/button'
import { useTheme } from '@/composables/useTheme'

withDefaults(defineProps<{ size?: ButtonVariants['size'] }>(), { size: 'icon' })

const { toggleTheme } = useTheme()
</script>

<template>
  <Button variant="outline" :size="size" @click="toggleTheme()">
    <Sun class="dark:hidden" />
    <Moon class="hidden dark:block" />
    <span class="sr-only">Toggle theme</span>
  </Button>
</template>
