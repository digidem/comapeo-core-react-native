import { comapeoServicesClient } from '@comapeo/core-react-native'

import type { TestContext } from './utils'

export function test({ describe, expect, it }: TestContext) {
	describe('map server', () => {
		it('getBaseUrl() returns a valid URL', async () => {
			const href = await comapeoServicesClient.mapServer.getBaseUrl()
			const url = new URL(href)
			expect(url.protocol).toBe('http:')
			expect(url.hostname).toBe('127.0.0.1')
			const localPort = parseInt(url.port, 10)
			expect(typeof localPort).toBe('number')
			expect(localPort).toBeGreaterThan(0)
		})

		it('serves HTTP on the given URL', async () => {
			const baseUrl = await comapeoServicesClient.mapServer.getBaseUrl()

			// We only assert the server accepts the connection and responds —
			// any HTTP status proves the socket is bound and the request
			// round-tripped through the in-process server.
			const response = await fetch(baseUrl)
			expect(typeof response.status).toBe('number')
		})
	})
}
