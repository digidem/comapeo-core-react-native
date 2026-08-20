import { requireNativeModule } from 'expo'
import { createClient } from 'rpc-reflector/client.js'
import type { MessagePortLike, MessageEvent } from 'rpc-reflector'

/**
 * Client for the backend's e2e-only `@@comapeo-debug/lifecycle` channel
 * (`backend/lib/debug-lifecycle.js`), which triggers backend-side project
 * lifecycle transitions the v10 contract tests need (a client cannot close a
 * project — lifecycle is server-owned). The id deliberately sits outside
 * @comapeo/ipc's `@@comapeo/` prefix so its router ignores these frames; the
 * backend serves the channel only when started with
 * `COMAPEO_DEBUG_LIFECYCLE=1`, otherwise calls here time out.
 */
const DEBUG_LIFECYCLE_CHANNEL_ID = '@@comapeo-debug/lifecycle'

// Long enough for a slow CI device to answer, short enough that an
// unserved channel (flag unset) resolves to "unavailable" well within a
// spec's 60s budget.
const DEBUG_RPC_TIMEOUT_MS = 10_000

type DebugLifecycleApi = {
	ping(): Promise<string>
	closeProject(projectPublicId: string): Promise<void>
}

/**
 * Same native socket the production clients ride: frames are JSON over the
 * ComapeoCore module's message port, so the debug channel multiplexes with
 * the `@@comapeo/*` channels. Mirrors the library's internal
 * `CoreMessagePort` (not exported) minus the expo EventEmitter dependency.
 */
class NativeMessagePort implements MessagePortLike {
	#native = requireNativeModule('ComapeoCore')
	#listeners = new Set<(event: MessageEvent) => void>()
	#handleNativeMessage = (event: { data: string }) => {
		let data: unknown
		try {
			data = JSON.parse(event.data)
		} catch {
			return
		}
		for (const listener of [...this.#listeners]) {
			listener({ data })
		}
	}

	postMessage(message: unknown): void {
		this.#native.postMessage(JSON.stringify(message))
	}

	addEventListener(type: 'message', listener: (event: MessageEvent) => void) {
		if (type !== 'message') return
		if (this.#listeners.size === 0) {
			this.#native.addListener('message', this.#handleNativeMessage)
		}
		this.#listeners.add(listener)
	}

	removeEventListener(
		type: 'message',
		listener: (event: MessageEvent) => void,
	) {
		if (type !== 'message') return
		this.#listeners.delete(listener)
		if (this.#listeners.size === 0) {
			this.#native.removeListener('message', this.#handleNativeMessage)
		}
	}
}

/** `{ id, message }` sub-channel framing, matching the backend's DebugSubChannel. */
class SubChannel implements MessagePortLike {
	#id: string
	#port: MessagePortLike
	#listeners = new Set<(event: MessageEvent) => void>()
	#handleMessage = ({ data }: MessageEvent) => {
		if (!data || typeof data !== 'object') return
		const { id, message } = data as { id?: unknown; message?: unknown }
		if (id !== this.#id) return
		for (const listener of [...this.#listeners]) {
			listener({ data: message })
		}
	}

	constructor(port: MessagePortLike, id: string) {
		this.#id = id
		this.#port = port
		this.#port.addEventListener('message', this.#handleMessage)
	}

	postMessage(message: unknown): void {
		this.#port.postMessage({ id: this.#id, message })
	}

	addEventListener(type: 'message', listener: (event: MessageEvent) => void) {
		if (type !== 'message') return
		this.#listeners.add(listener)
	}

	removeEventListener(
		type: 'message',
		listener: (event: MessageEvent) => void,
	) {
		if (type !== 'message') return
		this.#listeners.delete(listener)
	}
}

let debugClient: DebugLifecycleApi | null = null

function getDebugClient(): DebugLifecycleApi {
	if (!debugClient) {
		const channel = new SubChannel(
			new NativeMessagePort(),
			DEBUG_LIFECYCLE_CHANNEL_ID,
		)
		debugClient = createClient<DebugLifecycleApi>(channel, {
			timeout: DEBUG_RPC_TIMEOUT_MS,
		})
	}
	return debugClient
}

/**
 * One probe per app session decides whether the channel is served at all,
 * shared by every caller: the first `closeProjectOnBackend` pays at most one
 * `ping()` timeout (channel unserved — backend started without the flag) and
 * every later call skips straight to "unavailable" instead of stalling
 * another 10s. It also disambiguates timeouts: once the probe has succeeded,
 * an `RPC_TIMEOUT` from `closeProject` is a real backend hang and FAILS the
 * spec rather than quietly marking it pending.
 */
let channelServedPromise: Promise<boolean> | null = null

function isChannelServed(): Promise<boolean> {
	channelServedPromise ??= getDebugClient()
		.ping()
		.then(
			() => true,
			(error) => {
				if ((error as { code?: string })?.code === 'RPC_TIMEOUT') return false
				throw error
			},
		)
	return channelServedPromise
}

/**
 * Ask the backend to close a project server-side, as core would for its own
 * reasons. Resolves `true` when the backend confirmed the close; `false` when
 * the debug channel is not being served (backend started without
 * `COMAPEO_DEBUG_LIFECYCLE=1` — determined once via `ping()`, see above), so
 * specs can mark themselves pending instead of failing. With the channel
 * served, ANY `closeProject` rejection — timeouts included — is a real
 * failure and propagates.
 */
export async function closeProjectOnBackend(
	projectPublicId: string,
): Promise<boolean> {
	if (!(await isChannelServed())) return false
	await getDebugClient().closeProject(projectPublicId)
	return true
}
