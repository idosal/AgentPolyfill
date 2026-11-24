(() => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"]) {
    try { delete window[name]; } catch {}
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch {}
  }
})();
