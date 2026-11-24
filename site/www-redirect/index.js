// www.agentpolyfill.com answers with a permanent redirect to the same path on
// agentpolyfill.com, where the site is.
export default {
  fetch(request) {
    const url = new URL(request.url)
    return Response.redirect(`https://agentpolyfill.com${url.pathname}${url.search}`, 301)
  },
}
