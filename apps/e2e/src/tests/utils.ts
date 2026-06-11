import { ComapeoDoc } from '@comapeo/core/schema.js'
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
