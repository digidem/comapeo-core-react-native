import { useState } from 'react'
import jasmineRequire, {
	type JasmineDoneInfo,
} from 'jasmine-core/lib/jasmine-core/jasmine'
import { Button, ScrollView, Text, View } from 'react-native'

import { test as basicTest } from './tests/basic'
import { test as mapServerTest } from './tests/map-server'
import { test as mediaTest } from './tests/media'
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

// Default of 5s is too short for IPC-heavy tests on slow CI devices.
const DEFAULT_TIMEOUT_INTERVAL_MS = 60_000

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
				console.log('[e2e] jasmine started')
				setTestState({ status: 'pending', results: [] })
			},
			jasmineDone: (info) => {
				console.log(`[e2e] jasmine done: ${info.overallStatus}`)
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
			specStarted: (result) => {
				console.log(`[e2e] spec started: ${result.fullName}`)
			},
			specDone: (result) => {
				const describeText = result.fullName.replaceAll(result.description, '')

				if (result.status === 'passed') {
					console.log(`[e2e] PASS: ${result.fullName}`)
				} else {
					console.log(
						`[e2e] FAIL: ${result.fullName} — ${result.failedExpectations
							.map((e) => e.message)
							.join(' | ')}`,
					)
					for (const err of result.failedExpectations) {
						if (err.stack) console.log(`[e2e] stack: ${err.stack}`)
					}
				}

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

		const { describe, it, expect, expectAsync, jasmine, beforeEach, afterEach } =
			jasmineRequire.interface(jasmineCore, jasmineEnv)

		jasmine.DEFAULT_TIMEOUT_INTERVAL = DEFAULT_TIMEOUT_INTERVAL_MS

		const ctx = {
			describe,
			it,
			expect,
			expectAsync,
			jasmine,
			beforeEach,
			afterEach,
		}

		// 👇 Register tests here!
		basicTest(ctx)
		mapServerTest(ctx)
		mediaTest(ctx)
		projectCrudTest(ctx)

		await jasmineEnv.execute()
	}

	return (
		<ScrollView style={{ padding: 20 }} contentContainerStyle={{ gap: 20 }}>
			<Button
				title={testState.status === 'pending' ? 'Running…' : 'Run tests'}
				onPress={runTests}
				disabled={testState.status === 'pending'}
			/>

			{testState.status !== 'idle' ? (
				<View>
					<Text>
						{`${testState.status === 'pending' ? 'Pending' : 'Done'}: ${testState.results.filter((r) => r.passed).length} out of ${testState.results.length} tests passed`}
					</Text>

					{testState.status === 'done' ? (
						<Text testID="all-tests-done">Done.</Text>
					) : null}

					{testState.status === 'done' &&
					testState.info.overallStatus === 'passed' ? (
						<Text testID="all-tests-passed">All tests passed!</Text>
					) : null}

					{testState.status === 'done' &&
					testState.info.overallStatus !== 'passed' ? (
						<Text testID="all-tests-failed">
							{`Tests failed (${testState.info.overallStatus}).`}
						</Text>
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
