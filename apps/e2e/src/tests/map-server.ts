import { appRpcClient } from '@comapeo/core-react-native'

import type { TestContext } from './utils'

export function test({ describe, expect, expectAsync, it }: TestContext) {
	describe('map server', () => {
		it('listen() returns a usable local port', async () => {
			const { localPort, remotePort } = await appRpcClient.mapServer.listen()

			expect(typeof localPort).toBe('number')
			expect(localPort).toBeGreaterThan(0)
			expect(typeof remotePort).toBe('number')
			expect(remotePort).toBeGreaterThan(0)
		})

		it('listen() is idempotent across calls', async () => {
			const first = await appRpcClient.mapServer.listen()
			const second = await appRpcClient.mapServer.listen()

			// A second listen() must not rebind the shared HTTP server; it
			// returns the already-bound ports rather than throwing
			// ERR_SERVER_ALREADY_LISTEN.
			expect(second.localPort).toBe(first.localPort)
			expect(second.remotePort).toBe(first.remotePort)
		})

		it('serves HTTP on the local port', async () => {
			const { localPort } = await appRpcClient.mapServer.listen()
			const baseUrl = `http://127.0.0.1:${localPort}`

			// We only assert the server accepts the connection and responds —
			// any HTTP status proves the socket is bound and the request
			// round-tripped through the in-process server.
			const response = await fetch(baseUrl)
			expect(typeof response.status).toBe('number')
		})
	})
}
