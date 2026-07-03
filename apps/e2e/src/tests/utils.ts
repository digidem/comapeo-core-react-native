import { comapeo } from '@comapeo/core-react-native'
import { ComapeoDoc } from '@comapeo/core/schema.js'
import type { ComapeoProjectClientApi } from '@comapeo/ipc'
import { JasmineInterface } from 'jasmine-core/lib/jasmine-core/jasmine'

export type TestContext = Pick<
	JasmineInterface,
	| 'describe'
	| 'it'
	| 'expect'
	| 'expectAsync'
	| 'jasmine'
	| 'beforeEach'
	| 'afterEach'
>

/**
 * Returns an `openProject(projectId)` that tracks every opened project and
 * closes them all in `afterEach`. Close in afterEach to avoid leaking
 * listeners across tests (otherwise EventEmitter MaxListenersExceeded fires
 * and later tests slow down).
 */
export function trackOpenProjects(afterEach: TestContext['afterEach']) {
	const openProjects = new Set<ComapeoProjectClientApi>()

	afterEach(async () => {
		const projects = [...openProjects]
		openProjects.clear()
		await Promise.all(projects.map((p) => p.close().catch(() => undefined)))
	})

	return async function openProject(
		projectId: string,
	): Promise<ComapeoProjectClientApi> {
		const project = await comapeo.getProject(projectId)
		openProjects.add(project)
		return project
	}
}

export function sortBy<T>(arr: Array<T>, key: keyof T) {
	return arr.sort(function (a, b) {
		if (a[key] < b[key]) return -1
		if (a[key] > b[key]) return 1
		return 0
	})
}

export function sortById(docs: Array<ComapeoDoc>) {
	return sortBy(docs, 'docId')
}

export function randomDate() {
	return new Date(randomNum({ min: 0, max: Date.now() }))
}

export function randomBool() {
	return Math.random() >= 0.5
}

export function randomNum({
	min = 0,
	max = 1,
	precision,
}: { min?: number; max?: number; precision?: number } = {}) {
	const num = Math.random() * (max - min) + min
	if (typeof precision === 'undefined') return num
	return round(num, precision)
}

export function round(value: number, decimalPlaces: number) {
	return Math.round(value * 10 ** decimalPlaces) / 10 ** decimalPlaces
}

export async function delay(duration: number) {
	await new Promise((res) => {
		globalThis.setTimeout(res, duration)
	})
}

export function removeUndefinedFields(object: unknown) {
	return JSON.parse(JSON.stringify(object))
}
