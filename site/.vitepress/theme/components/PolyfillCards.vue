<script setup lang="ts">
import Recording from './Recording.vue'
import CopyCommand from './CopyCommand.vue'

// Every line here is taken from the repository's README and each polyfill's
// README. Keep them in step when those change.
const polyfills = [
  {
    name: 'Events',
    plugin: 'mcp-events',
    spec: 'SEP-3415, Final',
    id: 'io.modelcontextprotocol/events',
    state: 'Works',
    stateNote: 'Poll, push and webhook delivery; an event wakes an idle session. No OAuth servers.',
    line: 'Claude is woken when something happens: it watches events on your MCP servers and acts when one fires, even while the session sits idle.',
    video: '/media/events-button.mp4',
    poster: '/media/events-button.jpg',
    width: 1280,
    height: 720,
    alt: 'One sentence to Claude Code gives a private button page and a watch, and the session goes idle. Someone types "ship it" on the page and presses the button; the idle session wakes by itself and says what was typed.',
    add: 'claude mcp add --transport http feeds https://event-feeds.idosalomon.workers.dev/mcp',
    ask: 'Give me a demo button and tell me what I type when I press it',
    link: '/guide/events',
  },
  {
    name: 'Apps',
    plugin: 'mcp-apps-cli',
    spec: 'MCP Apps 2026-01-26, Stable',
    id: 'io.modelcontextprotocol/ui',
    state: 'Early',
    stateNote: 'App UIs render inline in the terminal, with mouse and keyboard. No OAuth servers.',
    line: "An MCP App's interface, in the terminal: it opens under the tool call and answers the mouse. Real pixels in iTerm2, kitty and Ghostty, character cells elsewhere.",
    video: '/media/apps.mp4',
    poster: '/media/apps.jpg',
    width: 880,
    height: 495,
    alt: 'In Claude Code, a classic shareware game from the hosted arcade server runs under the tool call and is played with keys and clicks. Then a cohort retention heatmap from another MCP server opens inline, shows a tooltip wherever the pointer goes, and a control switches its period. Last, a 3D scene opens and turns when dragged.',
    add: 'claude mcp add --transport http arcade https://mcp-apps-arcade.idosalomon.workers.dev/mcp',
    ask: 'Find a shareware game in the arcade and load it',
    link: '/guide/apps',
  },
  {
    name: 'Skills',
    plugin: 'mcp-skills',
    spec: 'SEP-2640, Final',
    id: 'io.modelcontextprotocol/skills',
    state: 'Early',
    stateNote: 'Skills served by an MCP server are listed, loaded and read in Claude Code, with the checks the spec asks of a client. No OAuth servers.',
    line: "Skills served by an MCP server appear in Claude's skill listing; Claude loads one when a task calls for it, after you approve it once.",
    video: '/media/skills.mp4',
    poster: '/media/skills.jpg',
    width: 960,
    height: 540,
    alt: "In Claude Code, the skills a server offers are listed. A question is asked, Claude asks to load one skill from the server, reads the files it points to, and answers from them.",
    add: 'claude mcp add --transport http huggingface https://huggingface.co/mcp',
    ask: 'Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?',
    link: '/guide/skills',
  },
  {
    name: 'Server Cards',
    plugin: 'mcp-server-cards',
    spec: 'SEP-2127, Final (extension Beta)',
    id: '',
    state: 'Early',
    stateNote: "Finds the servers a domain publishes, checks each card against the schema, and adds one to Claude Code's own config with a click, so servers behind OAuth work.",
    line: "Add a company's MCP server by its domain: Claude finds the servers it publishes and checks each card, and Add puts one into Claude Code's own config, so servers behind OAuth work.",
    video: '/media/server-cards.mp4',
    poster: '/media/server-cards.jpg',
    width: 1280,
    height: 720,
    alt: 'In Claude Code, the question What MCP servers does neon.com publish? lists Neon and Neon Docs, each with an Add button, from neon.com\'s own catalog. Add is pressed on Neon Docs, and it is added to Claude Code\'s configuration.',
    add: '',
    ask: 'What MCP servers does neon.com publish?',
    then: 'Then press Add on Neon Docs (no sign-in).',
    link: '/guide/server-cards',
  },
]
</script>

<template>
  <div class="ap-cards">
    <article v-for="p in polyfills" :key="p.name" class="card">
      <Recording :src="p.video" :poster="p.poster" :alt="p.alt" :width="p.width" :height="p.height" />
      <div class="body">
        <header>
          <h3><a :href="p.link">{{ p.name }}</a></h3>
          <span class="state" :data-state="p.state.toLowerCase()" :title="p.stateNote">{{ p.state }}</span>
        </header>
        <p class="spec"><template v-if="p.id"><code>{{ p.id }}</code> · </template>{{ p.spec }}</p>
        <p class="line">{{ p.line }}</p>
        <template v-if="p.add">
          <p class="step">Add the hosted demo server:</p>
          <CopyCommand :command="p.add" :label="`Add the ${p.name} demo server`" />
          <p class="step">Start <code>claude</code> and ask:</p>
        </template>
        <p v-else class="step">Nothing to set up. Start <code>claude</code> and ask:</p>
        <p class="ask">“{{ p.ask }}”</p>
        <p v-if="p.then" class="then">{{ p.then }}</p>
        <a class="more" :href="p.link">The {{ p.name }} guide <span aria-hidden="true">→</span></a>
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
  background: var(--ap-jade-soft);
  color: var(--vp-c-brand-1);
}
.spec {
  margin-top: 6px;
  font-size: 13px;
  color: var(--vp-c-text-3);
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
  overflow-wrap: anywhere;
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
.more:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
