<script setup lang="ts">
// A real recording, loaded only when it is about to be seen. A loop plays
// muted while it is on screen and pauses when it leaves; with reduced motion
// it waits for a press. The poster (a frame of the same recording) is in the
// server-rendered page, so the frame shows without JavaScript.
//
// Either `cut` names one of the launch video's cuts in media.json (its file,
// poster and size come from there), or `src`, `poster`, `width` and `height`
// give a recording from the repository.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'
import media from '../../../media.json'

const props = withDefaults(
  defineProps<{
    cut?: string
    src?: string
    poster?: string
    alt: string
    width?: number
    height?: number
    caption?: string
    loop?: boolean
    // false: plays on hover (with a mouse) or on a press, not by itself as it
    // scrolls into view; for a page with several recordings side by side.
    autoplay?: boolean
  }>(),
  { loop: true, autoplay: true },
)

// A cut keeps its file name when it is rendered again, so its hash goes in
// the URL: a browser that kept the old one fetches the new one.
const source = computed(() => {
  const cut = props.cut ? media.cuts.find((c) => c.name === props.cut) : undefined
  if (props.cut && !cut) throw new Error(`Recording: no cut named ${props.cut} in media.json`)
  if (cut) {
    const v = cut.sha256.slice(0, 12)
    const name = cut.poster.replace(/\.jpg$/, '')
    const webp = (w: number) => `${withBase(`/media/p/${name}-${w}.webp`)}?v=${v}`
    return {
      src: `/media/${cut.file}?v=${v}`,
      poster: webp(cut.webp[cut.webp.length - 1]),
      srcset: cut.webp.map((w) => `${webp(w)} ${w}w`).join(', '),
      width: cut.width,
      height: cut.height,
    }
  }
  return { src: props.src!, poster: withBase(props.poster!), srcset: '', width: props.width!, height: props.height! }
})
// A cut's poster is a lazy <img> with srcset over the video (WebP, sized to the
// slot, fetched only near the viewport), hidden once the video plays; a
// recording from the repository keeps the video's own poster.
const shown = ref(false)

const root = ref<HTMLElement>()
const video = ref<HTMLVideoElement>()
const loaded = ref(false)
const playing = ref(false)
const reduced = ref(false)
let observer: IntersectionObserver | undefined
let visible = false
let userPaused = false

const ratio = computed(() => `${source.value.width} / ${source.value.height}`)

function load() {
  if (loaded.value || !video.value) return
  loaded.value = true
  video.value.src = withBase(source.value.src)
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
  if (!props.autoplay) {
    // Load nothing until asked; with a mouse, hovering plays it.
    root.value!.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse' && !reduced.value) play()
    })
    root.value!.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !el.paused) el.pause()
    })
    return
  }
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
        :poster="source.srcset ? undefined : source.poster"
        :width="source.width"
        :height="source.height"
        :loop="loop"
        muted
        playsinline
        preload="none"
        :aria-label="alt"
        @click="toggle"
        @playing="shown = true"
      />
      <img
        v-if="source.srcset"
        v-show="!shown"
        class="poster"
        :srcset="source.srcset"
        sizes="(min-width: 960px) 688px, calc(100vw - 48px)"
        :src="source.poster"
        :width="source.width"
        :height="source.height"
        alt=""
        loading="lazy"
        decoding="async"
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

<style scoped>
.poster {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  background: var(--ap-screen);
}
</style>
