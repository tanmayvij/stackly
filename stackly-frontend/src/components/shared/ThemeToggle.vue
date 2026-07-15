<script setup lang="ts">
import { Moon, Sun } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/composables/useTheme'

const { toggleTheme } = useTheme()
</script>

<template>
  <Button variant="outline" size="icon" @click="toggleTheme()">
    <Sun class="dark:hidden" />
    <Moon class="hidden dark:block" />
    <span class="sr-only">Toggle theme</span>
  </Button>
</template>
