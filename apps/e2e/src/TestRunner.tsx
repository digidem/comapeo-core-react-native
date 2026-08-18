import { useState } from "react";
import jasmineRequire, {
  type JasmineDoneInfo,
} from "jasmine-core/lib/jasmine-core/jasmine";
import { Button, ScrollView, Text, View, type ErrorUtils } from "react-native";

import { test as basicTest } from "./tests/basic";
import { test as mapServerTest } from "./tests/map-server";
import { test as projectCrudTest } from "./tests/project-crud";

type TestResult = {
  id: string;
  name: string;
  passed: boolean;
  errors: Array<{ message: string; stack: string }>;
};

type TestState =
  | { status: "idle" | "pending"; results: Array<TestResult> }
  | {
      status: "done";
      overallStatus: JasmineDoneInfo["overallStatus"] | "timedOut";
      timedOutDuring?: string;
      results: Array<TestResult>;
    };

// Default of 5s is too short for IPC-heavy tests on slow CI devices.
const DEFAULT_TIMEOUT_INTERVAL_MS = 60_000;

// Self-report a stall before Maestro's 300s extendedWaitUntil gives up, so the
// results screenshot names the spec instead of the run dying with no evidence.
const WATCHDOG_TIMEOUT_MS = 240_000;

const rnGlobal = globalThis as {
  ErrorUtils?: ErrorUtils;
  HermesInternal?: {
    enablePromiseRejectionTracker?: (options: {
      allRejections: boolean;
      onUnhandled: (id: number, rejection: unknown) => void;
    }) => void;
  };
};

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || String(error);
  return String(error);
}

type GlobalErrorListener = (error: unknown, event?: unknown) => void;

// Same contract as jasmine-core's own GlobalErrors, adapted to React Native:
// ErrorUtils for uncaught errors, Hermes' rejection tracker for unhandled
// rejections. Neither is wired up in a Release build, where a swallowed
// rejection would otherwise hang `execute()` with no output at all.
function createGlobalErrorsClass(onUnhandledError: (message: string) => void) {
  return class ReactNativeGlobalErrors {
    #handlers: Array<GlobalErrorListener> = [];
    #overrideHandler: GlobalErrorListener | null = null;
    #onRemoveOverride: (() => void) | null = null;
    #previousHandler: Parameters<ErrorUtils["setGlobalHandler"]>[0] | null =
      null;

    install() {
      const errorUtils = rnGlobal.ErrorUtils;
      if (errorUtils) {
        this.#previousHandler = errorUtils.getGlobalHandler();
        errorUtils.setGlobalHandler((error: unknown) => this.#dispatch(error));
      }
      rnGlobal.HermesInternal?.enablePromiseRejectionTracker?.({
        allRejections: true,
        onUnhandled: (_id: number, rejection: unknown) =>
          this.#dispatch(rejection),
      });
    }

    uninstall() {
      if (this.#previousHandler) {
        rnGlobal.ErrorUtils?.setGlobalHandler(this.#previousHandler);
        this.#previousHandler = null;
      }
      // Hermes has no API to disable the tracker; late rejections keep
      // landing in #dispatch, which reports instead of swallowing.
    }

    pushListener(listener: GlobalErrorListener) {
      this.#handlers.push(listener);
    }

    popListener(listener: GlobalErrorListener) {
      if (!listener) throw new Error("popListener expects a listener");
      this.#handlers.pop();
    }

    setOverrideListener(listener: GlobalErrorListener, onRemove: () => void) {
      if (this.#overrideHandler) {
        throw new Error("Can't set more than one override listener at a time");
      }
      this.#overrideHandler = listener;
      this.#onRemoveOverride = onRemove;
    }

    removeOverrideListener() {
      this.#onRemoveOverride?.();
      this.#overrideHandler = null;
      this.#onRemoveOverride = null;
    }

    reportUnhandledRejections() {}

    #dispatch(error: unknown) {
      console.error(`[e2e] global error: ${formatError(error)}`);
      if (this.#overrideHandler) {
        this.#overrideHandler(error);
        return;
      }
      const handler = this.#handlers[this.#handlers.length - 1];
      if (handler) {
        handler(error);
      } else {
        onUnhandledError(formatError(error));
      }
    }
  };
}

export function TestRunner() {
  const [testState, setTestState] = useState<TestState>({
    status: "idle",
    results: [],
  });
  const [currentSpec, setCurrentSpec] = useState<string | null>(null);
  const [globalErrors, setGlobalErrors] = useState<Array<string>>([]);

  async function runTests() {
    const jasmineCore = jasmineRequire.core(jasmineRequire);

    const jasmineEnv = jasmineCore.getEnv({
      suppressLoadErrors: true,
      GlobalErrors: createGlobalErrorsClass((message) => {
        setGlobalErrors((prev) => [...prev, message]);
      }),
    });

    let runningSpec: string | null = null;
    let watchdogFired = false;

    jasmineEnv.addReporter({
      jasmineStarted: () => {
        console.log("[e2e] jasmine started");
        setTestState({ status: "pending", results: [] });
        setCurrentSpec(null);
        setGlobalErrors([]);
      },
      jasmineDone: (info) => {
        console.log(`[e2e] jasmine done: ${info.overallStatus}`);
        if (watchdogFired) return;
        setTestState((prev) => {
          if (prev.status === "done") {
            throw new Error(
              `Invalid state transition from '${prev.status}' to 'done'.`
            );
          }

          return {
            status: "done",
            overallStatus: info.overallStatus,
            results: prev.results,
          };
        });
      },
      specStarted: (result) => {
        console.log(`[e2e] spec started: ${result.fullName}`);
        runningSpec = result.fullName;
        setCurrentSpec(result.fullName);
      },
      specDone: (result) => {
        const describeText = result.fullName.replaceAll(result.description, "");

        if (result.status === "passed") {
          console.log(`[e2e] PASS: ${result.fullName}`);
        } else {
          console.log(
            `[e2e] FAIL: ${result.fullName} — ${result.failedExpectations
              .map((e) => e.message)
              .join(" | ")}`
          );
          for (const err of result.failedExpectations) {
            if (err.stack) console.log(`[e2e] stack: ${err.stack}`);
          }
        }

        if (watchdogFired) return;
        setTestState((prev) => {
          if (prev.status === "done") {
            throw new Error(
              `Invalid state transition from '${prev.status}' to 'done'.`
            );
          }

          return {
            status: "pending",
            results: [
              ...prev.results,
              {
                id: result.id,
                name: describeText
                  ? `${describeText} > ${result.description}`
                  : result.description,
                passed: result.status === "passed",
                errors: result.failedExpectations.map((err) => ({
                  message: err.message,
                  stack: err.stack,
                })),
              },
            ],
          };
        });
      },
    });

    const {
      describe,
      it,
      expect,
      expectAsync,
      jasmine,
      beforeEach,
      afterEach,
    } = jasmineRequire.interface(jasmineCore, jasmineEnv);

    jasmine.DEFAULT_TIMEOUT_INTERVAL = DEFAULT_TIMEOUT_INTERVAL_MS;

    const ctx = {
      describe,
      it,
      expect,
      expectAsync,
      jasmine,
      beforeEach,
      afterEach,
    };

    // 👇 Register tests here!
    basicTest(ctx);
    mapServerTest(ctx);
    projectCrudTest(ctx);

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      jasmineEnv.execute().then(() => "done" as const),
      new Promise<"timeout">((resolve) => {
        watchdog = setTimeout(() => resolve("timeout"), WATCHDOG_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(watchdog);

    if (outcome === "timeout") {
      watchdogFired = true;
      const during = runningSpec ?? "(no spec started)";
      console.error(`[e2e] Suite timed out during: ${during}`);
      setTestState((prev) => ({
        status: "done",
        overallStatus: "timedOut",
        timedOutDuring: during,
        results: prev.results,
      }));
    }
  }

  return (
    <ScrollView style={{ padding: 20 }} contentContainerStyle={{ gap: 20 }}>
      <Button
        title={testState.status === "pending" ? "Running…" : "Run tests"}
        onPress={runTests}
        disabled={testState.status === "pending"}
      />

      {testState.status !== "idle" ? (
        <View>
          <Text testID="test-progress">
            {`${testState.status === "pending" ? "Pending" : "Done"}: ${
              testState.results.filter((r) => r.passed).length
            } out of ${testState.results.length} tests passed`}
          </Text>

          {currentSpec ? (
            <Text testID="current-spec">{`Running: ${currentSpec}`}</Text>
          ) : null}

          {testState.status === "done" ? (
            <Text testID="all-tests-done">Done.</Text>
          ) : null}

          {testState.status === "done" &&
          testState.overallStatus === "passed" ? (
            <Text testID="all-tests-passed">All tests passed!</Text>
          ) : null}

          {testState.status === "done" &&
          testState.overallStatus !== "passed" ? (
            <Text testID="all-tests-failed">
              {testState.overallStatus === "timedOut"
                ? `Tests failed (timedOut). Suite timed out during: ${testState.timedOutDuring}`
                : `Tests failed (${testState.overallStatus}).`}
            </Text>
          ) : null}
        </View>
      ) : null}

      {globalErrors.length > 0 ? (
        <View>
          <Text testID="global-errors" style={{ color: "red" }}>
            Global errors (outside any spec):
          </Text>

          {globalErrors.map((message, i) => (
            <Text key={i} selectable style={{ color: "red" }}>
              {message}
            </Text>
          ))}
        </View>
      ) : null}

      {testState.results.map((result) => (
        <View key={result.id}>
          <Text selectable style={{ color: result.passed ? "green" : "red" }}>
            {result.passed ? "✓" : "✗"} {result.name}
          </Text>

          {result.errors.map((e, j) => (
            <Text key={j} selectable style={{ color: "red", marginLeft: 16 }}>
              {e.message}
            </Text>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
