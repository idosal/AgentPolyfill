<script setup lang="ts">
import { useData } from 'vitepress'
import CopyCommand from './CopyCommand.vue'

const { frontmatter } = useData()
</script>

<template>
  <div v-if="frontmatter.layout === 'home'" class="ap-install">
    <CopyCommand
      command="/plugin install agent-polyfill --marketplace idosal/AgentPolyfill"
      label="Install every polyfill"
      :wrap="false"
    />
    <p class="note">In Claude Code 2.1.329 or newer, then a new session. <a href="/guide/getting-started#codex">Using Codex?</a></p>
  </div>
</template>

<style scoped>
.note a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}
.note a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.note code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.92em;
}
</style>
