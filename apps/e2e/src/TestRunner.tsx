import { state } from '@comapeo/core-react-native'
import { useState } from 'react'
import jasmineRequire, {
	type JasmineDoneInfo,
} from 'jasmine-core/lib/jasmine-core/jasmine'
import { Button, ScrollView, Text, View } from 'react-native'

import { test as basicTest } from './tests/basic'
import { test as mapServerTest } from './tests/map-server'
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

// Guard for a local run without Maestro (the CI flow already waits for the
// backend-state-STARTED indicator before tapping "Run tests").
const STARTUP_WAIT_MS = 120_000

// Above the native layer's 120s reconnect window, so a backend that is still
// recovering gets its full window before the spec fails. The ERROR fast-reject
// in waitForBackendStarted plus the fail-fast flag in runTests mean this
// ceiling is only ever burned while recovery is genuinely in progress.
const BEFORE_EACH_WAIT_MS = 130_000

// Jasmine per-hook timeout (passed as beforeEach's second argument): must
// exceed BEFORE_EACH_WAIT_MS so a failure carries the wait's message, not a
// bare hook timeout.
const BEFORE_EACH_HOOK_TIMEOUT_MS = 150_000

function waitForBackendStarted(timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const sub = state.addListener('stateChange', (next) => {
			if (next === 'STARTED') settle()
			// ERROR is terminal (native reconnect exhausted its window):
			// reject at once instead of burning the timeout.
			else if (next === 'ERROR') fail('terminal ERROR')
		})
		const timer = setTimeout(() => {
			fail(`not STARTED after ${timeoutMs}ms`)
		}, timeoutMs)
		function cleanup() {
			clearTimeout(timer)
			sub.remove()
		}
		function settle() {
			cleanup()
			resolve()
		}
		function fail(why: string) {
			cleanup()
			const lastError = state.getLastError()
			const detail = lastError
				? ` (errorPhase=${lastError.errorPhase ?? 'unknown'}, errorMessage=${lastError.errorMessage ?? 'unknown'})`
				: ''
			reject(
				new Error(`Backend state is '${state.getState()}', ${why}${detail}`),
			)
		}
		// Checked after subscribing so a transition between the two can't be missed.
		const current = state.getState()
		if (current === 'STARTED') settle()
		else if (current === 'ERROR') fail('terminal ERROR')
	})
}

export function TestRunner() {
	const [testState, setTestState] = useState<TestState>({
		status: 'idle',
		results: [],
	})

	async function runTests() {
		// Disable the Run button for the whole pre-execute wait: jasmineStarted
		// (which sets 'pending' again — harmless) can be up to STARTUP_WAIT_MS
		// away, and a second tap must not start a concurrent suite.
		setTestState({ status: 'pending', results: [] })

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

		// If a mid-suite backend restart (e.g. the low-memory killer taking the
		// :ComapeoCore FGS) moves the state away from STARTED, pause the next
		// spec until it recovers instead of firing an RPC into a dead socket.
		// After the first failed wait, fail the remaining specs immediately: a
		// dead backend must still produce per-spec error messages and the
		// results screen inside Maestro's all-tests-done budget.
		let backendLost: Error | null = null
		beforeEach(async () => {
			if (backendLost) {
				throw new Error(`Backend already lost: ${backendLost.message}`)
			}
			try {
				await waitForBackendStarted(BEFORE_EACH_WAIT_MS)
			} catch (err) {
				backendLost = err instanceof Error ? err : new Error(String(err))
				throw err
			}
		}, BEFORE_EACH_HOOK_TIMEOUT_MS)

		// 👇 Register tests here!
		basicTest(ctx)
		mapServerTest(ctx)
		projectCrudTest(ctx)

		try {
			await waitForBackendStarted(STARTUP_WAIT_MS)
		} catch (err) {
			// Run the suite anyway: the specs' own failures carry more detail
			// than aborting here would.
			console.log(`[e2e] ${err instanceof Error ? err.message : String(err)}`)
		}

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
