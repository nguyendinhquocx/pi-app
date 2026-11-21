import { parseFrame, makeOk, makeErr, makePong, type Frame } from '@shared/remote'
import { hostFinishHs2, hostOpenHs1, keyPairFromPrivate, SecureChannel, type KeyPair } from '@shared/remote/crypto'

/**
 * In-process host simulator for web transport tests: real Noise-IK handshake + real
 * SecureChannel on both sides (via the isomorphic shared crypto), fake socket transport.
 * Used by HostConnection tests — NOT shipped anywhere.
 */

export class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string | ArrayBuffer | ArrayBufferView }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sent: (string | Uint8Array)[] = []
  closed = false

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === 'string') this.sent.push(data)
    else if (data instanceof ArrayBuffer) this.sent.push(new Uint8Array(data))
    else if (ArrayBuffer.isView(data)) this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    else this.sent.push(new Uint8Array(0))
  }

  close(): void {
    this.closed = true
  }

  // Test driver entry points
  open(): void {
    this.closed = false
    this.onopen?.()
  }

  receive(text: string): void {
    this.onmessage?.({ data: text })
  }

  receiveBinary(bytes: Uint8Array): void {
    const buf = bytes.slice().buffer
    this.onmessage?.({ data: buf })
  }

  clientSentText(): string | null {
    const last = this.sent.at(-1)
    return typeof last === 'string' ? last : null
  }

  clientSentBinary(): Uint8Array | null {
    const last = this.sent.at(-1)
    return last instanceof Uint8Array ? last : null
  }
}

export type HostSimOptions = {
  hostStatic: KeyPair
  hostId?: string
  hostName?: string
  epoch?: string
  role?: 'viewer' | 'operator'
  /** RPC handlers: method → (params) => result (already plain JSON). A never-settling promise simulates an in-flight request. */
  handlers?: Record<string, (params: unknown) => unknown>
  /** Force a handshake failure code (e.g. 'revoked'). */
  failHandshake?: 'revoked' | 'unpaired' | 'bad'
}

export class HostSim {
  private current: FakeSocket | null = null
  private channel: SecureChannel | null = null
  private readonly handlers: Record<string, (params: unknown) => unknown>
  private reqSeq = 0
  /** Protocol-level pings received (k:'ping'). */
  pingCount = 0
  /** Decoded one-time pair tokens observed in client hs1 messages (test only). */
  pairTokens: (string | undefined)[] = []

  constructor(private readonly opts: HostSimOptions) {
    this.handlers = opts.handlers ?? {}
  }

  /** The socket of the CURRENT connection (test driver view). */
  get socket(): FakeSocket {
    if (!this.current) throw new Error('host sim: no socket yet — call newSocket() from the socketFactory')
    return this.current
  }

  /** Called from the test's socketFactory: one fresh socket per connection attempt. */
  newSocket(): FakeSocket {
    const sock = new FakeSocket()
    this.current = sock
    sock.onmessage = (ev) => void this.onMessage(ev)
    // Route client→server traffic: the real gateway reads the socket, so every client send is
    // handed to the same handlers the receive path uses.
    const writable = sock as unknown as { send: (d: string | ArrayBufferLike | Blob | ArrayBufferView) => void }
    const originalSend = writable.send.bind(sock)
    writable.send = (data) => {
      originalSend(data)
      if (typeof data === 'string') void this.onMessage({ data })
      else if (data instanceof ArrayBuffer) void this.onMessage({ data })
      else if (ArrayBuffer.isView(data)) void this.onMessage({ data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) })
    }
    return sock
  }

  private onOpen(): void {
    if (this.opts.failHandshake) {
      this.socket.receive(JSON.stringify({ t: 'hs_err', code: this.opts.failHandshake }))
      this.close(4004)
    }
    // hs1 arrives as the client's first message through the send route.
  }

  private async onMessage(ev: { data: string | ArrayBuffer | ArrayBufferView }): Promise<void> {
    if (typeof ev.data === 'string') {
      if (this.channel) return this.close(4002)
      await this.handshake(ev.data)
      return
    }
    const bytes =
      ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength)
    if (!this.channel) return this.close(4002)
    let raw: unknown
    try {
      raw = this.channel.decrypt(bytes)
    } catch {
      return this.close(4002)
    }
    const frame = parseFrame(raw)
    if (!frame) return this.close(4003)
    if (frame.k === 'ping') {
      this.pingCount++
      return this.send(makePong(frame.id))
    }
    if (frame.k === 'req') {
      const handler = this.handlers[frame.m]
      this.reqSeq++
      if (!handler) return this.send(makeErr(frame.id, 'not_supported', `no handler for ${frame.m}`))
      try {
        // A handler may return a never-settling promise to simulate a request in flight.
        this.send(makeOk(frame.id, await handler(frame.p)))
      } catch (e) {
        const code = (e as { rpcCode?: string }).rpcCode
        this.send(makeErr(frame.id, (code as 'not_found') ?? 'internal', e instanceof Error ? e.message : String(e)))
      }
    }
  }

  private async handshake(text: string): Promise<void> {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return this.close(4004)
    }
    let opened
    try {
      opened = hostOpenHs1(this.opts.hostStatic, msg)
    } catch {
      // Wrong client key / malformed hs1 → hs_err then 4004, exactly like the real gateway.
      this.socket.receive(JSON.stringify({ t: 'hs_err', code: 'bad' }))
      return this.close(4004)
    }
    this.pairTokens.push(opened.payload.pair)
    const { msg: hs2, keys } = hostFinishHs2(this.opts.hostStatic, opened, {
      deviceId: 'dev_test',
      hostId: this.opts.hostId ?? 'host_test',
      hostName: this.opts.hostName ?? 'Test Host',
      epoch: this.opts.epoch ?? 'e_sim',
      role: this.opts.role ?? 'operator',
    })
    // The channel must exist BEFORE hs2 reaches the client: the client answers with its first
    // encrypted request synchronously inside the receive callback (hello), and the host side
    // must be able to decrypt it (otherwise the real gateway would close 4002 here too).
    this.channel = SecureChannel.forHost(keys)
    this.socket.receive(JSON.stringify(hs2))
  }

  private send(frame: Frame): void {
    if (!this.channel || this.socket.closed) return
    this.socket.receiveBinary(this.channel.encrypt(frame))
  }

  /** Server-initiated event push. */
  push(event: string, payload: unknown): void {
    if (!this.channel) throw new Error('host sim not online')
    this.send({ v: 1, k: 'evt', m: event, p: payload })
  }

  /** Close the current connection (network drop). A reconnect gets a fresh socket. */
  close(code = 1000): void {
    if (!this.current) return
    this.current.closed = true
    this.current.onclose?.({ code })
    this.channel = null
    this.current = null
  }

  get deviceId(): string {
    return 'dev_test'
  }

  get requestCount(): number {
    return this.reqSeq
  }
}

export function testKeyPair(seedHex: string): KeyPair {
  const priv = new Uint8Array(32)
  for (let i = 0; i < 32; i++) priv[i] = parseInt(seedHex.slice(i * 2, i * 2 + 2), 16)
  return keyPairFromPrivate(priv)
}
