import { comapeo } from '@comapeo/core-react-native'

import type { TestContext } from './utils'

export function test({ expect, it }: TestContext) {
	it('comapeo export is available', () => {
		expect(comapeo).toBeDefined()
	})
}
