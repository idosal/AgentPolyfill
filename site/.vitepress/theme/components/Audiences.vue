<script setup lang="ts">
import home from '../../../home.json'

// The three columns are in home.json, shared with the Markdown copy of the home
// page for agents. Text in backticks is code.
const audiences = home.audiences.map((a) => ({
  ...a,
  parts: a.text.split('`').map((text, i) => ({ text, code: i % 2 === 1 })),
}))
</script>

<template>
  <div class="ap-aud">
    <div v-for="a in audiences" :key="a.title" class="col">
      <h3>{{ a.title }}</h3>
      <p><template v-for="(part, i) in a.parts" :key="i"><code v-if="part.code">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></p>
      <a :href="a.link">{{ a.linkText }} <svg class="arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h9.5M9 4.5 12.5 8 9 11.5" /></svg></a>
    </div>
  </div>
</template>

<style scoped>
.ap-aud {
  display: grid;
  grid-template-columns: 1fr;
  gap: 32px;
  margin-top: 24px;
}
@media (min-width: 760px) {
  .ap-aud {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 40px;
  }
}
.col {
  display: flex;
  flex-direction: column;
}
h3 {
  font-size: 18px;
  font-weight: 650;
  line-height: 1.3;
  color: var(--vp-c-text-1);
}
p {
  margin-top: 10px;
  font-size: 15px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  text-wrap: pretty;
}
a {
  margin-top: auto;
  padding-top: 14px;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}
a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
}
a .arrow {
  width: 14px;
  height: 14px;
}
a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
