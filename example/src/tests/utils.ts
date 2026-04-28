import { Env } from 'jasmine-core/lib/jasmine-core/jasmine'

export type TestContext = Pick<Env, 'it' | 'expect'>
export type EmbeddedTestFn = (testContext: TestContext) => void
