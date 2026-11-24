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
    />
    <p class="note">Run it in Claude Code 2.1.329 or newer, then start a new session.</p>
  </div>
</template>

<style scoped>
.note code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.92em;
}
</style>
