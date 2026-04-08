interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean
  getTitlebarAreaRect(): DOMRect
  addEventListener(
    type: 'geometrychange',
    listener: (this: WindowControlsOverlay, event: Event) => void,
    options?: boolean | AddEventListenerOptions
  ): void
  removeEventListener(
    type: 'geometrychange',
    listener: (this: WindowControlsOverlay, event: Event) => void,
    options?: boolean | EventListenerOptions
  ): void
}

declare global {
  interface Navigator {
    windowControlsOverlay?: WindowControlsOverlay
  }
}

export {}
