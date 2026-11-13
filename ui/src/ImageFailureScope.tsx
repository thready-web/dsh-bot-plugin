import { createContext, useState, type ReactNode } from 'react'
import { createImageFailures } from './image-failures'

export const ImageFailureContext = createContext<ReturnType<typeof createImageFailures> | null>(null)

/** Key by session id at the view boundary. Cleared on navigation/unmount/reload; no storage or global URL history. */
export function ImageFailureScope({ children }: { children: ReactNode }) {
  const [failures] = useState(createImageFailures)
  return <ImageFailureContext.Provider value={failures}>{children}</ImageFailureContext.Provider>
}
