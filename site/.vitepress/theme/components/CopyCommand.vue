<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{ command: string; label?: string }>()
const copied = ref(false)
// Where a wrapped command may break: after a space, after a dot, after "//",
// and after a slash that ends a path segment. Each piece between those is kept
// whole, so neither a URL nor a flag like --marketplace splits at a hyphen.
const parts = computed(() => props.command.split(/(?<=\s|\.|[^/:]\/|\/\/)/))
let timer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  try {
    await navigator.clipboard.writeText(props.command)
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied.value = false), 1600)
  } catch {
    copied.value = false
  }
}
</script>

<template>
  <div class="ap-cmd">
    <code :aria-label="label"><template v-for="(part, i) in parts" :key="i"><wbr v-if="i" /><span class="piece">{{ part }}</span></template></code>
    <button type="button" :data-copied="copied" :aria-label="copied ? 'Copied' : 'Copy command'" @click="copy">
      <svg v-if="!copied" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <rect x="5.25" y="5.25" width="8" height="8" rx="1.5" />
        <path d="M10.75 5.25V3.75a1.5 1.5 0 0 0-1.5-1.5h-5.5a1.5 1.5 0 0 0-1.5 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
      </svg>
      <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M3 8.5l3.25 3.25L13 5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>{{ copied ? 'Copied' : 'Copy' }}</span>
    </button>
  </div>
</template>

<style scoped>
.piece {
  white-space: nowrap;
}
</style>
