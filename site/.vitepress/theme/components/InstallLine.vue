<script setup lang="ts">
import { ref } from 'vue'
import { useData } from 'vitepress'
import CopyCommand from './CopyCommand.vue'

// Quick install commands displayed on the home page.
const hosts = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: '/plugin install agent-polyfill --marketplace idosal/AgentPolyfill',
    label: 'Install the Claude Code bundle',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: [
      'codex plugin marketplace add idosal/AgentPolyfill',
      'codex plugin add mcp-events@agent-polyfill',
      'codex plugin add mcp-skills@agent-polyfill',
      'codex plugin add mcp-server-cards@agent-polyfill',
    ].join('\n'),
    label: 'Install the polyfills in Codex',
  },
]

const { frontmatter } = useData()
const current = ref(0)

// Arrow keys move between the tabs, as in any tab list.
function onKey(event: KeyboardEvent) {
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!step) return
  event.preventDefault()
  current.value = (current.value + step + hosts.length) % hosts.length
  document.getElementById(`install-tab-${hosts[current.value].id}`)?.focus()
}
</script>

<template>
  <div v-if="frontmatter.layout === 'home'" class="ap-install">
    <div class="tabs" role="tablist" aria-label="Install in" @keydown="onKey">
      <button
        v-for="(host, i) in hosts"
        :id="`install-tab-${host.id}`"
        :key="host.id"
        type="button"
        role="tab"
        :aria-selected="current === i"
        :aria-controls="`install-${host.id}`"
        :tabindex="current === i ? 0 : -1"
        @click="current = i"
      >{{ host.name }}</button>
    </div>
    <div
      v-for="(host, i) in hosts"
      v-show="current === i"
      :id="`install-${host.id}`"
      :key="host.id"
      role="tabpanel"
      :aria-labelledby="`install-tab-${host.id}`"
    >
      <CopyCommand :command="host.command" :label="host.label" :wrap="false" />
      <p v-if="host.id === 'claude-code'" class="note">At the prompt of a <code>claude</code> session, Claude Code 2.1.329 or newer. Then start a new session.</p>
      <p v-else class="note">In a terminal, with Codex 0.170 or newer and Node 20 or newer. Apps isn't in Codex yet.</p>
    </div>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 20px;
  margin-bottom: 10px;
}
.tabs button {
  padding: 2px 0 4px;
  border-bottom: 2px solid transparent;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-3);
  transition: color 0.15s, border-color 0.15s;
}
.tabs button:hover {
  color: var(--vp-c-text-1);
}
.tabs button[aria-selected='true'] {
  color: var(--vp-c-text-1);
  border-bottom-color: var(--vp-c-brand-1);
}
.tabs button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
  border-radius: 2px;
}
.note code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.92em;
}
</style>
