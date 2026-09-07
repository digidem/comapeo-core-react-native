import { comapeoServicesClient } from '@comapeo/core-react-native'
import { fetch as expoFetch } from 'expo/fetch'

import type { TestContext } from './utils'

/**
 * Size of the gzipped empty PBF `smp-noto-glyphs` serves for a range it has no
 * fixture for. Zero if the platform HTTP stack gunzipped the body first, hence
 * the inclusive bound at the callsite.
 */
const EMPTY_GLYPH_PBF_GZ_BYTES = 20

// Black-box smoke coverage for the map server as it actually runs on
// device: in-process inside nodejs-mobile, reached over loopback HTTP by
// the app's `fetch`. The module's own suite covers route/logic behaviour
// in Node — these only check that the real request → response pipeline
// delivers each response shape once it's running on nodejs-mobile, where
// the server side builds its responses from the `Response`/`Request`
// globals under a jitless V8. They use the built-in `fallback` map only:
// no project, no uploaded SMP, no network.
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

		// Guards the packaging of `smp-noto-glyphs`: if its fixtures aren't
		// reachable on device it silently serves the empty PBF for every
		// range, and maps render unlabelled with no error anywhere.
		it('serves real Noto glyphs, not the empty fallback', async () => {
			const baseUrl = await comapeoServicesClient.mapServer.getBaseUrl()

			const latin = await getGlyphRange(baseUrl, '0-255')
			// CJK — deliberately not shipped, so MapLibre renders it client-side
			// via `localIdeographFontFamily`. The control for the case above.
			const cjk = await getGlyphRange(baseUrl, '19968-20223')

			expect(latin.status).toBe(200)
			expect(latin.contentType).toContain('application/x-protobuf')
			// Every shipped range is tens of KB, gzipped or not.
			expect(latin.byteLength).toBeGreaterThan(1000)

			// An unshipped range must still be a 200 carrying the empty PBF, so
			// MapLibre renders blank instead of erroring on a 404.
			expect(cjk.status).toBe(200)
			expect(cjk.byteLength).toBeLessThanOrEqual(EMPTY_GLYPH_PBF_GZ_BYTES)
		})

		it('includes permissive CORS headers', async () => {
			const baseUrl = await comapeoServicesClient.mapServer.getBaseUrl()
			const response = await fetch(`${baseUrl}/maps/fallback/style.json`)
			expect(response.headers.get('access-control-allow-origin')).toBe('*')
		})
	})
}

async function getGlyphRange(baseUrl: string, range: string) {
	const response = await expoFetch(
		`${baseUrl}/maps/fallback/fonts/Noto%20Sans%20Regular/${range}.pbf.gz`,
	)
	return {
		status: response.status,
		contentType: response.headers.get('content-type'),
		byteLength: (await response.arrayBuffer()).byteLength,
	}
}
