import { comapeo } from '@comapeo/core-react-native'

import type { TestContext } from './utils'

export function test({ expect, it }: TestContext) {
	it('works', () => {
		expect(comapeo).toBeDefined()
	})

	it('does not work', () => {
		expect(false).toBe(true)
	})
}
