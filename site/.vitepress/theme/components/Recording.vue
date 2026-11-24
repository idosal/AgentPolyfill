<script setup lang="ts">
// A real recording, loaded only when it is about to be seen. A loop plays
// muted while it is on screen and pauses when it leaves; with reduced motion
// it waits for a press. The poster (a frame of the same recording) is in the
// server-rendered page, so the frame shows without JavaScript.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

const props = withDefaults(
  defineProps<{
    src: string
    poster: string
    alt: string
    width: number
    height: number
    caption?: string
    loop?: boolean
  }>(),
  { loop: true },
)

const root = ref<HTMLElement>()
const video = ref<HTMLVideoElement>()
const loaded = ref(false)
const playing = ref(false)
const reduced = ref(false)
let observer: IntersectionObserver | undefined
let visible = false
let userPaused = false

const ratio = computed(() => `${props.width} / ${props.height}`)

function load() {
  if (loaded.value || !video.value) return
  loaded.value = true
  video.value.src = withBase(props.src)
}

async function play() {
  const el = video.value
  if (!el) return
  load()
  try {
    await el.play()
  } catch {
    /* autoplay refused: the button still plays it */
  }
}

function toggle() {
  const el = video.value
  if (!el) return
  if (el.paused) {
    userPaused = false
    play()
  } else {
    userPaused = true
    el.pause()
  }
}

onMounted(() => {
  reduced.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const el = video.value
  if (!el) return
  el.addEventListener('play', () => (playing.value = true))
  el.addEventListener('pause', () => (playing.value = false))
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        visible = entry.isIntersecting
        if (visible && !reduced.value && !userPaused) play()
        else if (!visible && !el.paused) el.pause()
      }
    },
    { rootMargin: '120px 0px', threshold: 0.25 },
  )
  observer.observe(root.value!)
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <figure ref="root" class="ap-rec">
    <div class="frame" :style="{ aspectRatio: ratio }">
      <video
        ref="video"
        :poster="withBase(poster)"
        :width="width"
        :height="height"
        :loop="loop"
        muted
        playsinline
        preload="none"
        :aria-label="alt"
        @click="toggle"
      />
      <button type="button" class="toggle" :aria-label="playing ? 'Pause recording' : 'Play recording'" @click="toggle">
        <svg v-if="playing" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <rect x="3.5" y="2.5" width="3" height="11" rx="0.75" />
          <rect x="9.5" y="2.5" width="3" height="11" rx="0.75" />
        </svg>
        <svg v-else viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M4.5 2.9v10.2a.6.6 0 0 0 .92.5l8.03-5.1a.6.6 0 0 0 0-1L5.42 2.4a.6.6 0 0 0-.92.5z" />
        </svg>
      </button>
    </div>
    <figcaption v-if="caption || $slots.default">
      <slot>{{ caption }}</slot>
    </figcaption>
  </figure>
</template>
