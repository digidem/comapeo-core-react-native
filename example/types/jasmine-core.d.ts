declare module 'jasmine-core/lib/jasmine-core/jasmine' {
	// ─── Async callback ───────────────────────────────────────────────────────

	type DoneFn = () => void
	type ImplementationCallback =
		| ((done: DoneFn) => void)
		| (() => Promise<void>)
		| (() => void)

	// ─── Expectation results ──────────────────────────────────────────────────

	interface ExpectationResult {
		matcherName: string
		message: string
		stack: string
		passed: boolean
		globalErrorType?: 'afterAll' | 'load' | 'lateExpectation' | 'lateError'
		filename?: string
		lineno?: number
	}

	// ─── Spy ──────────────────────────────────────────────────────────────────

	interface SpyCallData {
		object: unknown
		invocationOrder: number
		args: unknown[]
		returnValue: unknown
		verified: boolean
	}

	interface CallTracker {
		any(): boolean
		count(): number
		argsFor(index: number): unknown[]
		thisFor(index: number): unknown
		all(): SpyCallData[]
		allArgs(): unknown[][]
		first(): SpyCallData
		mostRecent(): SpyCallData
		reset(): void
		saveArgumentsByValue(argsCloner?: (args: unknown[]) => unknown[]): void
	}

	interface SpyStrategy {
		callThrough(): Spy
		returnValue(value: unknown): Spy
		returnValues(...values: unknown[]): Spy
		throwError(error: string | Error): Spy
		callFake(fn: (...args: unknown[]) => unknown): Spy
		stub(): Spy
	}

	interface Spy {
		(...args: unknown[]): unknown
		and: SpyStrategy
		calls: CallTracker
		withArgs(...args: unknown[]): { and: SpyStrategy }
		[key: string]: unknown
	}

	// ─── Asymmetric equality testers ──────────────────────────────────────────

	interface AsymmetricEqualityTester {
		asymmetricMatch(other: unknown): boolean
	}

	// ─── Matchers ─────────────────────────────────────────────────────────────

	interface Matchers<T> {
		toBe(expected: T): void
		toEqual(expected: unknown): void
		toBeCloseTo(expected: number, precision?: number): void
		toBeDefined(): void
		toBeUndefined(): void
		toBeNull(): void
		toBeNullish(): void
		toBeNaN(): void
		toBeTrue(): void
		toBeFalse(): void
		toBeTruthy(): void
		toBeFalsy(): void
		toBeGreaterThan(expected: number): void
		toBeGreaterThanOrEqual(expected: number): void
		toBeLessThan(expected: number): void
		toBeLessThanOrEqual(expected: number): void
		toBePositiveInfinity(): void
		toBeNegativeInfinity(): void
		toBeInstanceOf(expected: new (...args: unknown[]) => unknown): void
		toContain(expected: unknown): void
		toMatch(expected: string | RegExp): void
		toHaveSize(expected: number): void
		toHaveBeenCalled(): void
		toHaveBeenCalledTimes(expected: number): void
		toHaveBeenCalledWith(...args: unknown[]): void
		toHaveBeenCalledOnceWith(...args: unknown[]): void
		toHaveBeenCalledBefore(expected: Spy): void
		toHaveSpyInteractions(): void
		toHaveNoOtherSpyInteractions(): void
		toHaveClass(expected: string): void
		toHaveClasses(expected: string[]): void
		toThrow(expected?: unknown): void
		toThrowError(
			expected?: string | RegExp | (new (...a: unknown[]) => Error),
		): void
		toThrowMatching(predicate: (thrown: unknown) => boolean): void
		nothing(): void
		not: Matchers<T>
	}

	interface AsyncMatchers<T> {
		toBeResolved(): Promise<void>
		toBeResolvedTo(expected: Awaited<T>): Promise<void>
		toBeRejected(): Promise<void>
		toBeRejectedWith(expected: unknown): Promise<void>
		toBeRejectedWithError(
			expected?: string | RegExp | (new (...a: unknown[]) => Error),
			message?: string | RegExp,
		): Promise<void>
		toBeRejectedWithMatching(predicate: (e: unknown) => boolean): Promise<void>
		toBePending(): Promise<void>
		not: AsyncMatchers<T>
	}

	// ─── Reporter event shapes ────────────────────────────────────────────────

	interface JasmineStartedInfo {
		totalSpecsDefined: number
		order: { random: boolean; seed: string | number }
	}

	interface JasmineDoneInfo {
		overallStatus: 'passed' | 'failed' | 'incomplete'
		totalTime: number
		numWorkers?: number
		incompleteReason?: string
		order: { random: boolean; seed: string | number }
		failedExpectations: ExpectationResult[]
		deprecationWarnings: ExpectationResult[]
	}

	interface SuiteStartedEvent {
		id: string
		fullName: string
		description: string
		filename?: string
	}

	interface SuiteDoneEvent extends SuiteStartedEvent {
		status: 'passed' | 'failed' | 'pending' | 'excluded'
		failedExpectations: ExpectationResult[]
		passedExpectations: ExpectationResult[]
		deprecationWarnings: ExpectationResult[]
		duration: number | null
		properties: Record<string, unknown> | null
	}

	interface SpecStartedEvent {
		id: string
		fullName: string
		description: string
		filename?: string
	}

	interface SpecDoneEvent extends SpecStartedEvent {
		status: 'passed' | 'failed' | 'pending' | 'excluded'
		failedExpectations: ExpectationResult[]
		passedExpectations: ExpectationResult[]
		deprecationWarnings: ExpectationResult[]
		pendingReason?: string
		duration: number | null
		properties: Record<string, unknown> | null
		debugLogs: string[] | null
	}

	// ─── Reporter ─────────────────────────────────────────────────────────────

	interface Reporter {
		jasmineStarted?(info: JasmineStartedInfo): void | Promise<void>
		jasmineDone?(info: JasmineDoneInfo): void | Promise<void>
		suiteStarted?(result: SuiteStartedEvent): void | Promise<void>
		suiteDone?(result: SuiteDoneEvent): void | Promise<void>
		specStarted?(result: SpecStartedEvent): void | Promise<void>
		specDone?(result: SpecDoneEvent): void | Promise<void>
	}

	// ─── Configuration ────────────────────────────────────────────────────────

	interface Configuration {
		random?: boolean
		seed?: number | string | null
		stopOnSpecFailure?: boolean
		failSpecWithNoExpectations?: boolean
		stopSpecOnExpectationFailure?: boolean
		specFilter?: (spec: unknown) => boolean
		autoCleanClosures?: boolean
		forbidDuplicateNames?: boolean
		verboseDeprecations?: boolean
		detectLateRejectionHandling?: boolean
		extraItStackFrames?: number
		extraDescribeStackFrames?: number
		safariYieldStrategy?: 'count' | 'time'
	}

	// ─── Env ──────────────────────────────────────────────────────────────────

	export interface Env {
		configure(config: Configuration): void
		configuration(): Required<Configuration>
		execute(runablesToRun?: string[]): Promise<JasmineDoneInfo>
		addReporter(reporter: Reporter): void
		provideFallbackReporter(reporter: Reporter): void
		clearReporters(): void
		topSuite(): Suite
		describe(description: string, fn: () => void): Suite
		xdescribe(description: string, fn: () => void): Suite
		fdescribe(description: string, fn: () => void): Suite
		it(description: string, fn?: ImplementationCallback, timeout?: number): Spec
		xit(
			description: string,
			fn?: ImplementationCallback,
			timeout?: number,
		): Spec
		fit(description: string, fn: ImplementationCallback, timeout?: number): Spec
		beforeEach(fn: ImplementationCallback, timeout?: number): void
		afterEach(fn: ImplementationCallback, timeout?: number): void
		beforeAll(fn: ImplementationCallback, timeout?: number): void
		afterAll(fn: ImplementationCallback, timeout?: number): void
		expect<T>(actual: T): Matchers<T>
		expectAsync<T>(actual: T | Promise<T>): AsyncMatchers<T>
		throwUnless<T>(actual: T): Matchers<T>
		throwUnlessAsync<T>(actual: T | Promise<T>): AsyncMatchers<T>
		pending(message?: string): void
		fail(error?: string | Error): void
		spyOn<T extends object, K extends keyof T>(obj: T, method: K): Spy
		spyOnProperty<T extends object>(
			obj: T,
			prop: keyof T,
			accessType?: 'get' | 'set',
		): Spy
		spyOnAllFunctions<T extends object>(
			obj: T,
			includeNonEnumerable?: boolean,
		): T
		createSpy(name?: string, originalFn?: (...args: unknown[]) => unknown): Spy
		createSpyObj(
			baseName: string,
			methodNames: string[] | Record<string, unknown>,
			propertyNames?: string[] | Record<string, unknown>,
		): Record<string, Spy>
		createSpyObj(
			methodNames: string[] | Record<string, unknown>,
			propertyNames?: string[] | Record<string, unknown>,
		): Record<string, Spy>
		getSpecProperty(key: string): unknown
		setSpecProperty(key: string, value: unknown): void
		setSuiteProperty(key: string, value: unknown): void
		allowRespy(allow: boolean): void
		setDefaultSpyStrategy(fn: (and: SpyStrategy) => void): void
		addSpyStrategy(name: string, fn: (...args: unknown[]) => unknown): void
		addCustomEqualityTester(
			tester: (a: unknown, b: unknown) => boolean | undefined,
		): void
		addMatchers(matchers: Record<string, unknown>): void
		addAsyncMatchers(matchers: Record<string, unknown>): void
		addCustomObjectFormatter(
			formatter: (value: unknown) => string | undefined,
		): void
		deprecated(
			message: string | Error,
			options?: { omitStackTrace?: boolean },
		): void
		spyOnGlobalErrorsAsync(fn: (spy: Spy) => Promise<void>): Promise<void>
		debugLog(msg: string): void
		pp(value: unknown): string
	}

	// ─── Suite / Spec metadata ────────────────────────────────────────────────

	interface Suite {
		id: string
		description: string
		fullName: string
	}

	interface Spec {
		id: string
		description: string
		fullName: string
	}

	// ─── Clock ────────────────────────────────────────────────────────────────

	interface Clock {
		install(): Clock
		uninstall(): void
		tick(millis: number): void
		mockDate(date?: Date): void
		withMock(fn: () => void): void
	}

	// ─── JasmineCore — returned by jasmineRequire.core() ─────────────────────

	interface JasmineCore {
		getEnv(options?: {
			suppressLoadErrors?: boolean
			GlobalErrors?: new (...args: unknown[]) => {
				install(): void
				uninstall(): void
			}
		}): Env
	}

	// ─── JasmineInterface — returned by jasmineRequire.interface() ───────────

	interface JasmineInterface {
		describe(description: string, fn: () => void): Suite
		xdescribe(description: string, fn: () => void): Suite
		fdescribe(description: string, fn: () => void): Suite
		it(description: string, fn?: ImplementationCallback, timeout?: number): Spec
		xit(
			description: string,
			fn?: ImplementationCallback,
			timeout?: number,
		): Spec
		fit(description: string, fn: ImplementationCallback, timeout?: number): Spec
		beforeEach(fn: ImplementationCallback, timeout?: number): void
		afterEach(fn: ImplementationCallback, timeout?: number): void
		beforeAll(fn: ImplementationCallback, timeout?: number): void
		afterAll(fn: ImplementationCallback, timeout?: number): void
		expect<T>(actual: T): Matchers<T>
		expectAsync<T>(actual: T | Promise<T>): AsyncMatchers<T>
		throwUnless<T>(actual: T): Matchers<T>
		throwUnlessAsync<T>(actual: T | Promise<T>): AsyncMatchers<T>
		pending(message?: string): void
		fail(error?: string | Error): void
		spyOn<T extends object, K extends keyof T>(obj: T, method: K): Spy
		spyOnProperty<T extends object>(
			obj: T,
			prop: keyof T,
			accessType?: 'get' | 'set',
		): Spy
		spyOnAllFunctions<T extends object>(
			obj: T,
			includeNonEnumerable?: boolean,
		): T
		getSpecProperty(key: string): unknown
		setSpecProperty(key: string, value: unknown): void
		setSuiteProperty(key: string, value: unknown): void
		jasmine: { DEFAULT_TIMEOUT_INTERVAL: number; [key: string]: unknown }
		[key: string]: unknown
	}

	// ─── Module export ────────────────────────────────────────────────────────
	// The module exports the raw jasmineRequire object. Call .core() to get the
	// jasmine instance, then .interface() to get the flat describe/it/expect API.

	const jasmineRequire: {
		core(self: unknown): JasmineCore
		interface(core: JasmineCore, env: Env): JasmineInterface
		[key: string]: unknown
	}

	export default jasmineRequire
}
