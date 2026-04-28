import { useState } from 'react'
import jasmineRequire from 'jasmine-core/lib/jasmine-core/jasmine'
import { Button, ScrollView, Text, View } from 'react-native'

import { test as basicTest } from './tests/basic'

export function TestRunner() {
	const [isRunning, setIsRunning] = useState(false)

	const [results, setResults] = useState<
		Array<{
			id: string
			name: string
			passed: boolean
			errors: Array<string>
		}>
	>([])

	async function runTests() {
		setResults([])
		setIsRunning(true)

		try {
			const jasmineCore = jasmineRequire.core(jasmineRequire)

			const jasmineEnv = jasmineCore.getEnv({
				suppressLoadErrors: true,
				GlobalErrors: NoopGlobalErrors,
			})

			jasmineEnv.addReporter({
				specDone: (result) => {
					setResults((prev) => [
						...prev,
						{
							id: result.id,
							name: result.fullName,
							passed: result.status === 'passed',
							errors: result.failedExpectations.map((err) => err.message),
						},
					])
				},
			})

			const { it, expect } = jasmineRequire.interface(jasmineCore, jasmineEnv)

			// 👇 Register tests here!
			basicTest({ it, expect })

			await jasmineEnv.execute()
		} catch (err) {
			throw err
		}
		setIsRunning(false)
	}

	return (
		<ScrollView style={{ padding: 20 }} contentContainerStyle={{ gap: 20 }}>
			<Button
				title={isRunning ? 'Running…' : 'Run Tests'}
				onPress={runTests}
				disabled={isRunning}
			/>

			{results.map((result) => (
				<View key={result.id}>
					<Text style={{ color: result.passed ? 'green' : 'red' }}>
						{result.passed ? '✓' : '✗'} {result.name}
					</Text>

					{result.errors.map((e, j) => (
						<Text key={j} style={{ color: 'red', marginLeft: 16 }}>
							{e}
						</Text>
					))}
				</View>
			))}
		</ScrollView>
	)
}

class NoopGlobalErrors {
	install() {}
	uninstall() {}
	pushListener() {}
	popListener() {}
	setOverrideListener() {}
	removeOverrideListener() {}
	reportUnhandledRejections() {}
}
