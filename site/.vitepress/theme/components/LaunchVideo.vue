<script setup lang="ts">
import { withBase } from 'vitepress'
import media from '../../../media.json'

const launch = media.launch
const seconds = Math.round(launch.seconds)
</script>

<template>
  <figure class="ap-launch">
    <div class="frame" :style="{ aspectRatio: `${launch.width} / ${launch.height}` }">
      <video
        controls
        playsinline
        preload="none"
        :width="launch.width"
        :height="launch.height"
        :poster="withBase(`/media/${launch.poster}`)"
        aria-label="The AgentPolyfill launch video: Apps, Events, Skills and Server Cards in real Claude Code sessions"
      >
        <source :src="withBase(`/media/${launch.file}`)" type="video/mp4" />
      </video>
    </div>
    <figcaption>{{ launch.caption }} <span class="len">{{ seconds }} s.</span></figcaption>
  </figure>
</template>

<style scoped>
.ap-launch {
  margin: 0;
}
.frame {
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  background: var(--ap-screen);
  box-shadow: 0 1px 2px rgba(10, 20, 15, 0.06), 0 16px 40px -20px rgba(10, 20, 15, 0.3);
}
:global(.dark) .frame {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 20px 48px -24px rgba(0, 0, 0, 0.8);
}
video {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--ap-screen);
}
figcaption {
  margin-top: 12px;
  max-width: 48em;
  font-size: 14px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  text-wrap: pretty;
}
</style>
