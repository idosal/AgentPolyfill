import DefaultTheme from 'vitepress/theme-without-fonts'
import type { Theme } from 'vitepress'
import { h } from 'vue'
import '@fontsource-variable/schibsted-grotesk/wght.css'
import './custom.css'
import InstallLine from './components/InstallLine.vue'
import LaunchVideo from './components/LaunchVideo.vue'
import PolyfillCards from './components/PolyfillCards.vue'
import Audiences from './components/Audiences.vue'
import Recording from './components/Recording.vue'
import CopyCommand from './components/CopyCommand.vue'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-actions-after': () => h(InstallLine),
    })
  },
  enhanceApp({ app }) {
    app.component('LaunchVideo', LaunchVideo)
    app.component('PolyfillCards', PolyfillCards)
    app.component('Audiences', Audiences)
    app.component('Recording', Recording)
    app.component('CopyCommand', CopyCommand)
  },
} satisfies Theme
