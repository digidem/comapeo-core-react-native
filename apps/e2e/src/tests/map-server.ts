import { comapeoServicesClient } from '@comapeo/core-react-native'

import type { TestContext } from './utils'

// Black-box smoke coverage for the map server as it actually runs on
// device: in-process inside nodejs-mobile, reached over loopback HTTP by
// the app's `fetch`. The module's own suite covers route/logic behaviour
// in Node — these only check that the real request → response pipeline
// (which differs on nodejs-mobile, e.g. the polyfilled fetch/Response
// globals) delivers each response shape. They use the built-in `fallback`
// map only: no project, no uploaded SMP, no network.
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

		it('serves the fallback map style.json', async () => {
			const baseUrl = await comapeoServicesClient.mapServer.getBaseUrl()
			const response = await fetch(`${baseUrl}/maps/fallback/style.json`)
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toContain('application/json')
			const style = (await response.json()) as {
				version?: number
				sources?: unknown
			}
			expect(style.version).toBe(8)
			expect(typeof style.sources).toBe('object')
		})

		it('serves the fallback map info', async () => {
			const baseUrl = await comapeoServicesClient.mapServer.getBaseUrl()
			const response = await fetch(`${baseUrl}/maps/fallback/info`)
			expect(response.status).toBe(200)
			const info = (await response.json()) as { name?: unknown; size?: unknown }
			expect(typeof info.name).toBe('string')
			expect(typeof info.size).toBe('number')
		})

		it('returns a structured 404 for an unknown map', async () => {
			const baseUrl = await comapeoServicesClient.mapServer.getBaseUrl()
			const response = await fetch(`${baseUrl}/maps/nonexistent/style.json`)
			expect(response.status).toBe(404)
			const body = (await response.json()) as { code?: unknown }
			expect(body.code).toBe('MAP_NOT_FOUND')
		})

		it('includes permissive CORS headers', async () => {
			const baseUrl = await comapeoServicesClient.mapServer.getBaseUrl()
			const response = await fetch(`${baseUrl}/maps/fallback/style.json`)
			expect(response.headers.get('access-control-allow-origin')).toBe('*')
		})
	})
}
