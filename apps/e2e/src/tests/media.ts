import {
	comapeo,
	getMediaBaseUrl,
	getShareableMediaUrl,
	toMediaUrl,
} from '@comapeo/core-react-native'
import { File, Paths } from 'expo-file-system'
import { Image, Platform } from 'react-native'
import { base64ToUint8Array } from 'uint8array-extras'

import { trackOpenProjects, type TestContext } from './utils'

// Black-box coverage of media (blob) serving as it actually runs on
// device: bytes go in through the public `$blobs.create` RPC, come back
// out through the platform image pipeline (`Image.getSize` drives the
// same ContentProvider / URL-loader path `<Image>` uses), and cross the
// process boundary via `getShareableMediaUrl`. No sockets, providers, or
// URL protocols are named anywhere — if any layer of the pipeline
// breaks, these fail; if the implementation is swapped out, they don't.
//
// A 1×1 PNG (smallest valid image) — `Image.getSize` succeeding on the
// served URL proves the full store → serve → decode round trip.
const PNG_1X1_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function getImageSize(uri: string) {
	return new Promise<{ width: number; height: number }>((resolve, reject) => {
		Image.getSize(
			uri,
			(width, height) => resolve({ width, height }),
			(error: unknown) =>
				reject(
					error instanceof Error
						? error
						: new Error(`Image.getSize failed for ${uri}: ${String(error)}`),
				),
		)
	})
}

export function test({ describe, expect, it, afterEach }: TestContext) {
	describe('media (blobs over the in-app media URL)', () => {
		const openProject = trackOpenProjects(afterEach)

		async function createProjectWithBlob() {
			const projectId = await comapeo.createProject({ name: 'media-e2e' })
			const project = await openProject(projectId)

			// Materialise a real image where the backend process can read it
			// (cache dir is inside the shared app sandbox on both platforms).
			const pngBytes = base64ToUint8Array(PNG_1X1_BASE64)
			const file = new File(Paths.cache, `media-e2e-${Date.now()}.png`)
			file.write(pngBytes)

			const created = await project.$blobs.create(
				{ original: file.uri.replace(/^file:\/\//, '') },
				{ mimeType: 'image/png' },
			)
			const relativeUrl = await project.$blobs.getUrl({
				driveId: created.driveId,
				type: created.type,
				variant: 'original',
				name: created.name,
			})
			return { relativeUrl, pngBytes }
		}

		it('getMediaBaseUrl() returns a platform-native base URL', () => {
			const base = getMediaBaseUrl()
			if (Platform.OS === 'android') {
				expect(base.startsWith('content://')).toBe(true)
				expect(base.endsWith('.comapeo.media')).toBe(true)
			} else {
				expect(base).toBe('comapeo://media')
			}
			// A base, not a full URL: composition appends the relative path.
			expect(base.endsWith('/')).toBe(false)
		})

		it('$blobs.getUrl() returns a relative path (core is URL-agnostic)', async () => {
			const { relativeUrl } = await createProjectWithBlob()
			expect(relativeUrl.startsWith('/blobs/')).toBe(true)
			// No scheme/host anywhere — the platform decides how it's served.
			expect(relativeUrl.includes('://')).toBe(false)
		})

		it('a stored blob loads through the platform image pipeline', async () => {
			const { relativeUrl } = await createProjectWithBlob()
			const url = toMediaUrl(relativeUrl)
			expect(url).toBe(getMediaBaseUrl() + relativeUrl)

			// Image.getSize resolving with the right dimensions proves the
			// bytes were served and decoded — the same path <Image> uses.
			const size = await getImageSize(url)
			expect(size.width).toBe(1)
			expect(size.height).toBe(1)
		})

		it('a missing blob fails to load rather than hanging', async () => {
			const { relativeUrl } = await createProjectWithBlob()
			const bogus = toMediaUrl(
				relativeUrl.replace(/[^/]+$/, '0000000000000000'),
			)
			let failed = false
			try {
				await getImageSize(bogus)
			} catch {
				failed = true
			}
			expect(failed).toBe(true)
		})

		it('getShareableMediaUrl() snapshots the blob to a shareable file', async () => {
			const { relativeUrl, pngBytes } = await createProjectWithBlob()

			// Accepts the in-app URL form; returns a file:// snapshot with an
			// extension derived from the served content type.
			const shareUrl = await getShareableMediaUrl(toMediaUrl(relativeUrl))
			expect(shareUrl.startsWith('file://')).toBe(true)
			expect(shareUrl.endsWith('.png')).toBe(true)

			const shared = new File(shareUrl)
			expect(shared.exists).toBe(true)
			const sharedBytes = await shared.bytes()
			expect(Array.from(sharedBytes)).toEqual(Array.from(pngBytes))
		})
	})
}
