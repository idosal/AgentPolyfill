<script setup lang="ts">
// The launch video, loaded only when played. Until then its poster is shown
// whole, with a play button of the site's own, so the browser's control bar
// does not cover the poster's caption; once it plays, the browser's controls
// take over for seeking and full screen. Without JavaScript the browser's
// controls are there from the start.
import { onMounted, ref } from 'vue'
import { withBase } from 'vitepress'
import media from '../../../media.json'

const launch = media.launch
const seconds = Math.round(launch.seconds)
// A new render keeps the file name, so its hash goes in the URL: browsers that
// kept the old one fetch the new one.
const version = launch.sha256.slice(0, 12)
const video = ref<HTMLVideoElement>()
const hydrated = ref(false)
const started = ref(false)

onMounted(() => (hydrated.value = true))

function play() {
  started.value = true
  video.value?.play().catch(() => {})
}
</script>

<template>
  <figure class="ap-launch">
    <div class="frame" :style="{ aspectRatio: `${launch.width} / ${launch.height}` }">
      <video
        ref="video"
        :controls="!hydrated || started"
        playsinline
        preload="none"
        :width="launch.width"
        :height="launch.height"
        :poster="withBase(`/media/${launch.poster}?v=${version}`)"
        :aria-label="`The AgentPolyfill launch video. ${launch.description}`"
        @play="started = true"
      >
        <source :src="withBase(`/media/${launch.file}?v=${version}`)" type="video/mp4" />
      </video>
      <button v-if="hydrated && !started" type="button" class="play" :aria-label="`Play the launch video, ${seconds} seconds`" @click="play">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M4.5 2.9v10.2a.6.6 0 0 0 .92.5l8.03-5.1a.6.6 0 0 0 0-1L5.42 2.4a.6.6 0 0 0-.92.5z" />
        </svg>
        <span aria-hidden="true">Play<span class="long"> the launch video</span></span>
        <span class="len" aria-hidden="true">{{ seconds }} s</span>
      </button>
    </div>
  </figure>
</template>

<style scoped>
.ap-launch {
  margin: 0;
}
.frame {
  position: relative;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  background: var(--ap-screen);
  box-shadow: 0 1px 2px rgba(10, 20, 15, 0.06), 0 12px 24px -16px rgba(10, 20, 15, 0.28);
}
/* Scoped to this frame: a bare :global(.dark) compiled to ".dark { ... }" and
   put a shadow on every dark-mode image, the logos included. */
:global(.dark .ap-launch .frame) {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 12px 24px -16px rgba(0, 0, 0, 0.7);
}
video {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--ap-screen);
}
.play {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px 12px 16px;
  border-radius: 999px;
  font-size: 15px;
  font-weight: 600;
  color: #e7ece9;
  background: rgba(10, 12, 11, 0.78);
  border: 1px solid rgba(231, 236, 233, 0.18);
  white-space: nowrap;
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.6);
  transition: background-color 0.15s, transform 0.15s;
}
.play:hover {
  background: rgba(10, 12, 11, 0.92);
  transform: translate(-50%, -50%) scale(1.03);
}
.play svg {
  width: 16px;
  height: 16px;
}
.play .len {
  font-weight: 500;
  color: rgba(231, 236, 233, 0.7);
}
@media (max-width: 479px) {
  .play {
    font-size: 13px;
    padding: 9px 14px 9px 12px;
  }
  .play .long {
    display: none;
  }
}
</style>
