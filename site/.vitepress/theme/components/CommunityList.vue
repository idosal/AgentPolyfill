<script setup lang="ts">
// The community directory, from ../community/polyfills.json at the root of
// the repository (checked by scripts/community.mjs before the build).
import community from '../../../../community/polyfills.json'
import CopyCommand from './CopyCommand.vue'

type Entry = {
  name: string
  extension: string
  id?: string
  spec: string
  specUrl: string
  hosts: string[]
  summary: string
  repository: string
  install: string
  maintainer: string
  contract: { clientRules: string; otherServer: boolean; standDown: string; limits: boolean }
}

const list = community.polyfills as Entry[]
const rules = { tested: 'a test for each', partial: 'partly tested', no: 'not tested' } as Record<string, string>
const standDown = { detects: 'detects native support', setting: 'a setting turns it off', no: 'none' } as Record<string, string>
</script>

<template>
  <p v-if="!list.length" class="ap-empty">Nothing is listed yet.</p>
  <div v-else class="ap-community">
    <article v-for="p in list" :key="p.name">
      <h3><a :href="p.repository">{{ p.name }}</a></h3>
      <p class="meta">
        <a :href="p.specUrl">{{ p.extension }}, {{ p.spec }}</a> · {{ p.hosts.join(', ') }} · by
        <a :href="`https://github.com/${p.maintainer}`">{{ p.maintainer }}</a>
      </p>
      <p>{{ p.summary }}</p>
      <CopyCommand :command="p.install" :label="`Install ${p.name}`" />
      <p class="contract">
        As its author states: client rules {{ rules[p.contract.clientRules] }};
        {{ p.contract.otherServer ? 'run against a server its author did not write' : 'not yet run against another server' }};
        stand-down: {{ standDown[p.contract.standDown] }};
        limits {{ p.contract.limits ? 'stated' : 'not stated' }}.
      </p>
    </article>
  </div>
</template>

<style scoped>
.ap-empty {
  color: var(--vp-c-text-2);
}
.ap-community article + article {
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid var(--vp-c-divider);
}
.meta,
.contract {
  font-size: 14px;
  color: var(--vp-c-text-2);
}
.contract {
  margin-top: 12px;
}
</style>
