// While a Raster is moving, wake the terminal's frame clock. An idle
// transcript accepts blits but does not paint them until some text changes.
// This single blank cell occupies the spare column beside the app.
import type { ClientModule } from 'claude-code'

const Paint: ClientModule<{}, boolean> = (_, surface) => {
  if (surface.state === undefined) {
    let phase = false
    surface.setState(phase)
    surface.every(surface.isMotionReduced ? 100 : 33, () => {
      phase = !phase
      surface.setState(phase)
    })
  }
  return surface.elements.Text({ children: [surface.state ? '\u2800' : ' '] })
}
export default Paint
