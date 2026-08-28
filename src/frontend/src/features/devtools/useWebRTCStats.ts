import { useEffect, useRef, useState } from 'react'
import { Room, Track } from 'livekit-client'


export type LayerInfo = {
  /** top published layer, e.g. '1280x720' */
  availRes?: string
  /** number of published spatial layers (simulcast/SVC), when known */
  layerCount?: number
  /** largest attached element size in device px, e.g. '480x270' */
  elementRes?: string
  /** why the forwarded layer is below the top one */
  reason?: 'adaptive' | 'bandwidth' | 'paused' | 'off-screen'
}

export type TrackRow = {
  key: string
  dir: 'up' | 'down'
  kind: string
  label: string
  codec?: string
  kbps: number
  fps?: number
  res?: string
  lossPct?: number
  limitation?: string
  /** subscribed video only: SFU layer forwarding context */
  layer?: LayerInfo
  /** this track froze during the last tick */
  froze?: boolean
}

export type StatsSnapshot = {
  ts: number
  /** wire totals from transport stats (includes headers, RTCP, FEC) */
  upKbps: number
  downKbps: number
  rttMs?: number
  /** worst inbound RTP jitter across subscribed tracks */
  jitterMs?: number
  availableOutKbps?: number
  /** selected ICE route of the publisher transport (measured, not assumed) */
  route?: { protocol?: string; type?: string; relayProtocol?: string }
  /**
   * relayProtocol values of gathered relay local candidates — i.e. which
   * client→TURN transports are actually configured (udp/tcp/tls). Empty
   * when no TURN server is configured.
   */
  turnProtocols: string[]
  tracks: TrackRow[]
}

type StatDict = Record<string, unknown>
type Counters = Record<string, number>

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined

const shortCodec = (mimeType?: string) =>
  mimeType ? mimeType.replace(/^(audio|video)\//, '') : undefined

type TrackContext = { label: string; layer?: LayerInfo; publishedH?: number }

/**
 * msTrackId -> label + subscribed-layer context, rebuilt on every tick.
 * The "why is this tile blurry" answer needs SDK state (publication +
 * element size) joined with getStats (forwarded resolution); this is the
 * SDK-state half.
 */
const buildTrackContext = (room: Room) => {
  const contexts = new Map<string, TrackContext>()
  room.localParticipant.trackPublications.forEach((pub) => {
    const id = pub.track?.mediaStreamTrack?.id
    if (id) contexts.set(id, { label: `local ${pub.source}` })
  })
  const dpr = window.devicePixelRatio || 1
  room.remoteParticipants.forEach((participant) => {
    // Keep rows scannable: participant names capped at 10 chars.
    const rawName = participant.name || participant.identity
    const name = rawName.length > 15 ? `${rawName.slice(0, 15)}.` : rawName
    participant.trackPublications.forEach((pub) => {
      const track = pub.track
      const id = track?.mediaStreamTrack?.id
      if (!track || !id) return
      const label = `${name} ${pub.source}`
      if (track.kind !== Track.Kind.Video) {
        contexts.set(id, { label })
        return
      }
      let elementRes: string | undefined
      let elementH: number | undefined
      for (const element of track.attachedElements) {
        const w = Math.round(element.clientWidth * dpr)
        const h = Math.round(element.clientHeight * dpr)
        if (elementH === undefined || h > elementH) {
          elementH = h
          elementRes = `${w}x${h}`
        }
      }
      const dims = pub.dimensions
      const layers = pub.trackInfo?.layers?.length
      contexts.set(id, {
        label,
        publishedH: dims?.height,
        layer: {
          availRes: dims ? `${dims.width}x${dims.height}` : undefined,
          layerCount: layers && layers > 1 ? layers : undefined,
          elementRes,
          reason: !pub.isEnabled
            ? 'off-screen'
            : track.streamState === Track.StreamState.Paused
              ? 'paused'
              : undefined,
        },
      })
    })
  })
  return contexts
}

/** Decide why a forwarded layer is below the published top layer. */
const resolveLayerReason = (
  context: TrackContext,
  forwardedH: number | undefined
): LayerInfo | undefined => {
  const layer = context.layer
  if (!layer) return undefined
  if (layer.reason) return layer // off-screen / paused already decided
  const publishedH = context.publishedH
  if (!publishedH || !forwardedH || forwardedH >= publishedH * 0.9) {
    return { ...layer, reason: undefined } // full quality, nothing to explain
  }
  // Below top layer: if the element only needs about what we get, it's
  // adaptiveStream fitting the element; otherwise the SFU is holding back
  // a layer the element could use — congestion.
  const elementH = layer.elementRes
    ? Number(layer.elementRes.split('x')[1])
    : undefined
  const adaptive = elementH !== undefined && forwardedH >= elementH * 0.7
  return { ...layer, reason: adaptive ? 'adaptive' : 'bandwidth' }
}

export const useWebRTCStats = (
  room: Room,
  enabled: boolean,
  intervalMs = 1000
) => {
  // Single source of truth: the snapshot is just the last history entry.
  const [history, setHistory] = useState<StatsSnapshot[]>([])
  const prevRef = useRef(new Map<string, Counters>())

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    const prev = prevRef.current

    /** Per-stat counter deltas; returns 0 on the first sighting. */
    const deltas = (key: string, now: Counters): Counters => {
      const before = prev.get(key)
      prev.set(key, now)
      const out: Counters = {}
      for (const [name, value] of Object.entries(now)) {
        out[name] = before?.[name] !== undefined ? value - before[name] : 0
      }
      return out
    }

    const collect = async () => {
      const reports: Array<{ pc: 'pub' | 'sub'; report: RTCStatsReport }> = []
      try {
        // Not public API — see file header.
        const manager = room.engine?.pcManager
        const pub = await manager?.publisher?.getStats()
        if (pub) reports.push({ pc: 'pub', report: pub })
        const sub = await manager?.subscriber?.getStats()
        if (sub) reports.push({ pc: 'sub', report: sub })
      } catch {
        // Engine not ready or SDK internals changed; panel shows nothing.
      }
      if (cancelled || reports.length === 0) return

      const contexts = buildTrackContext(room)
      const tracks: TrackRow[] = []
      let upKbps = 0
      let downKbps = 0
      let rttMs: number | undefined
      let jitterMs: number | undefined
      let availableOutKbps: number | undefined
      let route: StatsSnapshot['route']
      const turnProtocols = new Set<string>()

      for (const { pc, report } of reports) {
        const byId = new Map<string, StatDict>()
        report.forEach((stat) => byId.set(stat.id as string, stat as StatDict))

        report.forEach((raw) => {
          const stat = raw as StatDict
          const type = asString(stat.type)
          const ts = asNumber(stat.timestamp) ?? Date.now()
          const key = `${pc}:${asString(stat.id) ?? ''}`

          if (
            type === 'local-candidate' &&
            asString(stat.candidateType) === 'relay'
          ) {
            // Relay candidates are only gathered when a TURN server is
            // configured and reachable; relayProtocol says how the client
            // reaches it (udp/tcp/tls) — a turn:…?transport=udp server
            // must NOT be presented as a TURN/TLS capability.
            turnProtocols.add(
              asString(stat.relayProtocol) ?? asString(stat.protocol) ?? 'udp'
            )
          }

          if (type === 'transport') {
            const d = deltas(key, {
              sent: asNumber(stat.bytesSent) ?? 0,
              received: asNumber(stat.bytesReceived) ?? 0,
              ts,
            })
            if (d.ts > 0) {
              upKbps += Math.max(0, (d.sent * 8) / d.ts)
              downKbps += Math.max(0, (d.received * 8) / d.ts)
            }
          }

          if (type === 'candidate-pair' && stat.nominated === true) {
            const rtt = asNumber(stat.currentRoundTripTime)
            if (rtt !== undefined) rttMs = Math.round(rtt * 1000)
            const available = asNumber(stat.availableOutgoingBitrate)
            if (available !== undefined && pc === 'pub') {
              availableOutKbps = Math.round(available / 1000)
            }
            if (pc === 'pub') {
              const local = byId.get(asString(stat.localCandidateId) ?? '')
              route = {
                protocol: asString(local?.protocol),
                type: asString(local?.candidateType),
                relayProtocol: asString(local?.relayProtocol),
              }
            }
          }

          if (type === 'outbound-rtp' || type === 'inbound-rtp') {
            const isUp = type === 'outbound-rtp'
            const kind = asString(stat.kind)

            if (!isUp) {
              const jitter = asNumber(stat.jitter)
              if (jitter !== undefined) {
                const ms = Math.round(jitter * 1000)
                if (jitterMs === undefined || ms > jitterMs) jitterMs = ms
              }
            }

            // Packet loss: reported directly on inbound-rtp; for outbound it
            // lives on the matching remote-inbound-rtp (what the SFU got).
            let packetsLost = asNumber(stat.packetsLost) ?? 0
            if (isUp) {
              const remote = byId.get(asString(stat.remoteId) ?? '')
              packetsLost = asNumber(remote?.packetsLost) ?? 0
            }

            const d = deltas(key, {
              bytes: asNumber(isUp ? stat.bytesSent : stat.bytesReceived) ?? 0,
              packets:
                asNumber(isUp ? stat.packetsSent : stat.packetsReceived) ?? 0,
              packetsLost,
              ts,
              freezeCount: asNumber(stat.freezeCount) ?? 0,
            })

            const kbps = d.ts > 0 ? Math.max(0, (d.bytes * 8) / d.ts) : 0
            const lostTotal = d.packetsLost + d.packets
            const lossPct =
              lostTotal > 0
                ? Math.max(0, Math.min(100, (d.packetsLost / lostTotal) * 100))
                : 0

            // Resolve codec + source track.
            const codecStat = byId.get(asString(stat.codecId) ?? '')
            let msTrackId = asString(stat.trackIdentifier)
            if (!msTrackId && isUp) {
              const mediaSource = byId.get(asString(stat.mediaSourceId) ?? '')
              msTrackId = asString(mediaSource?.trackIdentifier)
            }
            const rid = asString(stat.rid)
            const context = msTrackId ? contexts.get(msTrackId) : undefined
            const baseLabel =
              context?.label ??
              `${kind ?? 'media'} ssrc ${asNumber(stat.ssrc) ?? '?'}`

            const width = asNumber(stat.frameWidth)
            const height = asNumber(stat.frameHeight)

            tracks.push({
              key,
              dir: isUp ? 'up' : 'down',
              kind: kind ?? 'unknown',
              label: rid ? `${baseLabel} [${rid}]` : baseLabel,
              codec: shortCodec(asString(codecStat?.mimeType)),
              kbps,
              fps: asNumber(stat.framesPerSecond),
              res: width && height ? `${width}x${height}` : undefined,
              lossPct,
              limitation:
                asString(stat.qualityLimitationReason) === 'none'
                  ? undefined
                  : asString(stat.qualityLimitationReason),
              layer:
                !isUp && kind === 'video' && context
                  ? resolveLayerReason(context, height)
                  : undefined,
              froze: !isUp && kind === 'video' && d.freezeCount > 0,
            })
          }
        })
      }

      // Stable order (direction, then label): sorting by bitrate would
      // reshuffle rows on every tick as kbps fluctuates.
      tracks.sort((a, b) =>
        a.dir === b.dir
          ? a.label.localeCompare(b.label)
          : a.dir === 'up'
            ? -1
            : 1
      )

      const next: StatsSnapshot = {
        ts: Date.now(),
        upKbps: Math.round(upKbps),
        downKbps: Math.round(downKbps),
        rttMs,
        jitterMs,
        availableOutKbps,
        route,
        turnProtocols: Array.from(turnProtocols).sort(),
        tracks,
      }
      setHistory((h) => [...h.slice(-59), next])
    }

    void collect()
    const id = window.setInterval(() => void collect(), intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [room, enabled, intervalMs])

  return { snapshot: history[history.length - 1], history }
}
