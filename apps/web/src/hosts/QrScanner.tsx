import { useEffect, useRef, useState } from 'react'

/**
 * QR scan for pairing (spec T3: "Pair each host by QR scan or pasted web pair link").
 * Uses the platform BarcodeDetector where available; gracefully hides otherwise (the paste
 * field stays the always-available path). Camera is requested only while the scanner is open.
 */

type ScanResult = { text: string } | null

export function qrScanSupported(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia
}

export function QrScanner({ onResult, onError }: { onResult: (text: string) => void; onError?: (message: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [supported] = useState(qrScanSupported)
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (!active || !supported) return
    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false

    void (async () => {
      try {
        const ctor = (window as unknown as { BarcodeDetector: { new (opts?: { formats?: string[] }): { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> } } }).BarcodeDetector
        const detector = new ctor({ formats: ['qr_code'] })
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        const video = videoRef.current
        if (!video || stopped) return
        video.srcObject = stream
        await video.play()
        const tick = async () => {
          if (stopped) return
          try {
            const codes = await detector.detect(video)
            if (codes.length > 0) {
              stopped = true
              onResult(codes[0].rawValue)
              return
            }
          } catch {
            /* frame not ready; keep scanning */
          }
          raf = requestAnimationFrame(() => void tick())
        }
        void tick()
      } catch (e) {
        onError?.(e instanceof Error ? e.message : 'camera unavailable')
        setActive(false)
      }
    })()

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      if (stream) for (const track of stream.getTracks()) track.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, supported])

  if (!supported) return null

  return (
    <div className="pair-actions">
      {!active ? (
        <button onClick={() => setActive(true)}>Quét QR từ camera</button>
      ) : (
        <>
          <video ref={videoRef} className="qr-preview" playsInline muted aria-label="camera QR preview" />
          <button onClick={() => setActive(false)}>Dừng quét</button>
        </>
      )}
    </div>
  )
}

export type { ScanResult }
