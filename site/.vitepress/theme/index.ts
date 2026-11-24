import DefaultTheme from 'vitepress/theme-without-fonts'
import type { Theme } from 'vitepress'
import { h } from 'vue'
import '@fontsource-variable/schibsted-grotesk/wght.css'
import './custom.css'
import InstallLine from './components/InstallLine.vue'
import LaunchVideo from './components/LaunchVideo.vue'
import PolyfillCards from './components/PolyfillCards.vue'
import Recording from './components/Recording.vue'
import CopyCommand from './components/CopyCommand.vue'
import PageMarkdown from './components/PageMarkdown.vue'
import CommunityList from './components/CommunityList.vue'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-actions-after': () => h(InstallLine),
      'doc-footer-before': () => h(PageMarkdown),
    })
  },
  enhanceApp({ app }) {
    app.component('LaunchVideo', LaunchVideo)
    app.component('PolyfillCards', PolyfillCards)
    app.component('Recording', Recording)
    app.component('CopyCommand', CopyCommand)
    app.component('CommunityList', CommunityList)
  },
} satisfies Theme
