/** Geometry for the canvas stage. Fit shrinks the whole device box; actual keeps 1:1 and pans. */

export interface CanvasDeviceSize {
  width: number
  height: number
}

export interface CanvasStageBox {
  width: number
  height: number
}

export interface CanvasFrameBox {
  /** 1 in actual size. Below 1 only when fit has to shrink the device viewport. */
  scale: number
  /** The iframe's own layout size in CSS pixels. Never scaled by `zoom`, only by the wrapper. */
  frameWidth: number
  frameHeight: number
  /** The wrapper's layout size, so the stage centers and scrolls the scaled box. */
  boxWidth: number
  boxHeight: number
}

export function canvasFrameBox(
  stage: CanvasStageBox,
  device: CanvasDeviceSize,
  fit: boolean,
  gap: number,
): CanvasFrameBox {
  const frameWidth = Math.max(1, Math.round(device.width))
  const frameHeight = Math.max(1, Math.round(device.height))
  const measured = {
    width: Number.isFinite(stage.width) ? stage.width : 0,
    height: Number.isFinite(stage.height) ? stage.height : 0,
  }
  const roomWidth = Math.max(measured.width - gap, 0)
  const roomHeight = Math.max(measured.height - gap, 0)
  const scale =
    fit && roomWidth > 0 && roomHeight > 0 ? Math.min(1, roomWidth / frameWidth, roomHeight / frameHeight) : 1
  // Actual size fills the stage height and pans horizontally; before the stage is measured,
  // fall back to the real device height so the first paint is not a sliver.
  const height = fit || measured.height <= 0 ? frameHeight : Math.round(measured.height)
  return {
    scale,
    frameWidth,
    frameHeight: height,
    boxWidth: frameWidth * scale,
    boxHeight: height * scale,
  }
}

/** Fit is the phone default; a wide window opens at actual size like before. */
export function defaultCanvasFit(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(max-width: 800px), (pointer: coarse)').matches
}
