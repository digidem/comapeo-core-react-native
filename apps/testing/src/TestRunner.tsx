import { useState } from 'react'
import jasmineRequire, {
	type JasmineDoneInfo,
} from 'jasmine-core/lib/jasmine-core/jasmine'
import { Button, ScrollView, Text, View } from 'react-native'

import { test as basicTest } from './tests/basic'
import { test as projectCrudTest } from './tests/project-crud'

type TestResult = {
	id: string
	name: string
	passed: boolean
	errors: Array<{ message: string; stack: string }>
}

type TestState =
	| { status: 'idle' | 'pending'; results: Array<TestResult> }
	| { status: 'done'; info: JasmineDoneInfo; results: Array<TestResult> }

export function TestRunner() {
	const [testState, setTestState] = useState<TestState>({
		status: 'idle',
		results: [],
	})

	async function runTests() {
		const jasmineCore = jasmineRequire.core(jasmineRequire)

		const jasmineEnv = jasmineCore.getEnv({
			suppressLoadErrors: true,
			GlobalErrors: NoopGlobalErrors,
		})

		jasmineEnv.addReporter({
			jasmineStarted: () => {
				setTestState({ status: 'pending', results: [] })
			},
			jasmineDone: (info) => {
				setTestState((prev) => {
					if (prev.status === 'done') {
						throw new Error(
							`Invalid state transition from '${prev.status}' to 'done'.`,
						)
					}

					return {
						status: 'done',
						info,
						results: prev.results,
					}
				})
			},
			specDone: (result) => {
				const describeText = result.fullName.replaceAll(result.description, '')

				setTestState((prev) => {
					if (prev.status === 'done') {
						throw new Error(
							`Invalid state transition from '${prev.status}' to 'done'.`,
						)
					}

					return {
						status: 'pending',
						results: [
							...prev.results,
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
						],
					}
				})
			},
		})

		const { describe, it, expect, expectAsync, jasmine } =
			jasmineRequire.interface(jasmineCore, jasmineEnv)

		// 👇 Register tests here!
		basicTest({ describe, it, expect, expectAsync, jasmine })
		projectCrudTest({ describe, it, expect, expectAsync, jasmine })

		await jasmineEnv.execute()
	}

	return (
		<ScrollView style={{ padding: 20 }} contentContainerStyle={{ gap: 20 }}>
			<Button
				title={testState.status === 'pending' ? 'Running…' : 'Run Tests'}
				onPress={runTests}
				disabled={testState.status === 'pending'}
			/>

			{testState.status !== 'idle' ? (
				<View>
					<Text>
						{`${testState.status === 'pending' ? 'Pending' : 'Done'}: ${testState.results.filter((r) => r.passed).length} out of ${testState.results.length} tests passed`}
					</Text>

					{testState.status === 'done' &&
					testState.info.overallStatus === 'passed' ? (
						<Text testID="all-tests-passed">All tests passed!</Text>
					) : null}
				</View>
			) : null}

			{testState.results.map((result) => (
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
