<script setup lang="ts">
// Under each guide page: the page as Markdown (written by scripts/agents.mjs),
// the site's llms.txt, and a button that copies the Markdown, for pasting into
// an agent.
import { computed, ref } from 'vue'
import { useData, withBase } from 'vitepress'

const { page } = useData()
const href = computed(() => withBase(`/${page.value.relativePath.replace(/\.md$/, '')}.md`))
const state = ref<'idle' | 'copied' | 'failed'>('idle')

async function copy() {
  try {
    const response = await fetch(href.value)
    if (!response.ok) throw new Error(String(response.status))
    await navigator.clipboard.writeText(await response.text())
    state.value = 'copied'
  } catch {
    state.value = 'failed'
  }
  setTimeout(() => (state.value = 'idle'), 2000)
}
</script>

<template>
  <div v-if="!page.isNotFound" class="ap-md">
    <span class="label">For agents</span>
    <a :href="href" target="_blank" rel="noopener">This page as Markdown</a>
    <a :href="withBase('/llms.txt')" target="_blank" rel="noopener">llms.txt</a>
    <button type="button" @click="copy">
      {{ state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy page' }}
    </button>
    <span class="sr" aria-live="polite">{{ state === 'copied' ? 'Page copied as Markdown' : '' }}</span>
  </div>
</template>

<style scoped>
.ap-md {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  margin-top: 48px;
  padding-top: 16px;
  border-top: 1px solid var(--vp-c-divider);
  font-size: 13px;
  line-height: 20px;
}
.label {
  color: var(--vp-c-text-2);
  font-weight: 500;
}
a,
button {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}
a:hover,
button:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
button {
  padding: 0;
  font-size: inherit;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
