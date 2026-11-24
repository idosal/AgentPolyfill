<script setup lang="ts">
import Recording from './Recording.vue'
import CopyCommand from './CopyCommand.vue'
import home from '../../../home.json'

// The cards' lines are in home.json, shared with the Markdown copy of the home
// page for agents.
const polyfills = home.polyfills
</script>

<template>
  <div class="ap-cards">
    <article v-for="p in polyfills" :key="p.name" class="card">
      <Recording :cut="p.cut" :alt="p.alt" />
      <div class="body">
        <header>
          <h3><a :href="p.link">{{ p.name }}</a></h3>
          <span class="state" :data-state="p.state.toLowerCase()" :title="p.stateNote">{{ p.state }}</span>
        </header>
        <p class="spec"><template v-if="p.id"><code>{{ p.id }}</code> · </template><span class="whole">{{ p.spec }}</span></p>
        <p class="line">{{ p.line }}</p>
        <template v-if="p.add">
          <p class="step">{{ p.addStep }}</p>
          <CopyCommand :command="p.add" :label="`Add the ${p.name} demo server`" />
          <p class="step">Start <code>claude</code> and ask:</p>
        </template>
        <p v-else class="step">Nothing to set up. Start <code>claude</code> and ask:</p>
        <p class="ask">“{{ p.ask }}”</p>
        <p v-if="p.then" class="then">{{ p.then }}</p>
        <a class="more" :href="p.link">The {{ p.name }} guide <svg class="arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h9.5M9 4.5 12.5 8 9 11.5" /></svg></a>
      </div>
    </article>
  </div>
</template>

<style scoped>
.ap-cards {
  display: grid;
  grid-template-columns: 1fr;
  gap: 40px;
  margin-top: 32px;
}
@media (min-width: 760px) {
  .ap-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 56px 40px;
  }
}
.card {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.body {
  display: flex;
  flex-direction: column;
  flex: 1;
  padding-top: 20px;
}
header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
h3 {
  font-size: 22px;
  line-height: 1.25;
  font-weight: 650;
  letter-spacing: -0.01em;
}
h3 a {
  color: var(--vp-c-text-1);
  transition: color 0.15s;
}
h3 a:hover {
  color: var(--vp-c-brand-1);
}
.state {
  flex: none;
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-border);
  color: var(--vp-c-text-2);
}
.state[data-state='works'] {
  border-color: transparent;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-1);
}
.spec {
  margin-top: 6px;
  font-size: 13px;
  color: var(--vp-c-text-3);
}
.spec .whole {
  white-space: nowrap;
}
.spec code {
  font-size: 12px;
  padding: 1px 4px;
}
.line {
  margin-top: 12px;
  font-size: 15px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  text-wrap: pretty;
}
.step {
  margin-top: 18px;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}
.step code {
  font-weight: 500;
}
.card :deep(.ap-cmd) {
  align-items: flex-start;
}
.card :deep(.ap-cmd code) {
  white-space: normal;
  overflow-wrap: break-word;
}
.ask {
  font-size: 15px;
  line-height: 1.55;
  color: var(--vp-c-text-1);
}
.then {
  margin-top: 6px;
  font-size: 14px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}
.more {
  margin-top: auto;
  padding-top: 18px;
  align-self: flex-start;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}
.more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.more .arrow {
  width: 14px;
  height: 14px;
}
.more:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
