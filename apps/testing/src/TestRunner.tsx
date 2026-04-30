import { useState } from 'react'
import jasmineRequire from 'jasmine-core/lib/jasmine-core/jasmine'
import { Button, ScrollView, Text, View } from 'react-native'

import { test as basicTest } from './tests/basic'
import { test as projectCrudTest } from './tests/project-crud'

export function TestRunner() {
	const [isRunning, setIsRunning] = useState(false)

	const [results, setResults] = useState<
		Array<{
			id: string
			name: string
			passed: boolean
			errors: Array<{ message: string; stack: string }>
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
					const describeText = result.fullName.replaceAll(
						result.description,
						'',
					)

					setResults((prev) => [
						...prev,
						{
							id: result.id,
							name: describeText
								? `${describeText} > ${result.description}`
								: result.description,
							passed: result.status === 'passed',
							errors: result.failedExpectations.map((err) => ({
								message: err.message,
								stack: err.stack,
							})),
						},
					])
				},
			})

			const { describe, it, expect, expectAsync, jasmine } =
				jasmineRequire.interface(jasmineCore, jasmineEnv)

			// 👇 Register tests here!
			basicTest({ describe, it, expect, expectAsync, jasmine })
			projectCrudTest({ describe, it, expect, expectAsync, jasmine })

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
					<Text selectable style={{ color: result.passed ? 'green' : 'red' }}>
						{result.passed ? '✓' : '✗'} {result.name}
					</Text>

					{result.errors.map((e, j) => (
						<Text key={j} selectable style={{ color: 'red', marginLeft: 16 }}>
							{e.message}
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
