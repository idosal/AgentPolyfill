<template>
  <div class="ap-aud">
    <div class="col">
      <h3>If you use agents</h3>
      <p>One line to install, one line to try. Each polyfill is a plugin of its own that you can disable or uninstall on its own.</p>
      <a href="/guide/getting-started">Getting started <span aria-hidden="true">→</span></a>
    </div>
    <div class="col">
      <h3>If you build</h3>
      <p>
        The <code>create-polyfill</code> and <code>design-extension</code> skills, and the contract every
        polyfill here meets. New polyfills are welcome.
      </p>
      <a href="/guide/build-a-polyfill">Build a polyfill <span aria-hidden="true">→</span></a>
    </div>
    <div class="col">
      <h3>If you write specs</h3>
      <p>A polyfill can be the client half of the two implementations an extension needs to reach Stable.</p>
      <a href="/guide/spec-authors">For spec authors <span aria-hidden="true">→</span></a>
    </div>
  </div>
</template>

<style scoped>
.ap-aud {
  display: grid;
  grid-template-columns: 1fr;
  gap: 32px;
  margin-top: 32px;
  border-top: 1px solid var(--vp-c-divider);
  padding-top: 32px;
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
a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
