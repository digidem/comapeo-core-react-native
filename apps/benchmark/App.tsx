import {
  unstable_messagePort,
  state,
  type ComapeoState,
} from "@comapeo/core-react-native";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/**
 * Bench app entry. Drives the bench RPC bridge through the same
 * RN→native→Node UDS path as production, talking to the stripped
 * backend selected via `comapeoEntryFile`. See README.md.
 *
 * Span transport: every recorded span is `console.log("BENCH_SPAN
 * <json>")`'d, lands in Android logcat / iOS device console; the BS
 * dispatch script greps it out of pulled device logs.
 */

const PAYLOAD_SIZES = [64, 1024, 65536, 1048576] as const;
const DEFAULT_SELECTED: ReadonlyArray<number> = [64, 1024, 65536];
const WARMUP_ITERATIONS = 10;
const STEADY_ITERATIONS = 100;
const REQUEST_TIMEOUT_MS = 30_000;

type BenchSpan = {
  op: "rpc";
  name: string;
  startTimestamp: number;
  durationMs: number;
  attrs: { bytes: number; rttSide: "rn"; device: string };
};

/**
 * `attrs.device` for every span this run emits. Format must match the
 * native loader's `--device=<tag>` so the summarizer groups RN-side
 * and backend-side spans under one row.
 */
function deriveDeviceTag(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Platform = require("react-native").Platform as {
    OS: string;
    constants?: Record<string, unknown>;
  };
  const c = Platform.constants ?? {};
  if (Platform.OS === "android") {
    const brand = (c.Manufacturer ?? c.Brand ?? "android") as string;
    const model = (c.Model ?? "device") as string;
    const release = (c.Release ?? "?") as string;
    return `${brand} ${model} (Android ${release})`;
  }
  if (Platform.OS === "ios") {
    // Tag matches NodeJSService.swift's `UIDevice.current.model`
    // (always "iPhone"/"iPad") so summarizer groups RN + backend.
    const sysName = (c.systemName ?? "iOS") as string;
    const sysVer = (c.osVersion ?? c.systemVersion ?? Platform.Version ?? "?") as string;
    const idiom = String(c.interfaceIdiom ?? "phone").toLowerCase();
    const model = idiom === "pad" ? "iPad" : idiom === "tv" ? "Apple TV" : "iPhone";
    return `Apple ${model} (${sysName} ${sysVer})`;
  }
  return Platform.OS;
}

const DEVICE_TAG = deriveDeviceTag();

type SizeStats = {
  sizeBytes: number;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
};

type RunReport = {
  runId: string;
  startedAt: string;
  device: { os: string; arch?: string };
  stats: SizeStats[];
  spanFile: string;
};

type BenchResponse = { result?: unknown; error?: { message: string } };

class BenchClient {
  private nextId = 0;
  private pending = new Map<
    string,
    { resolve: (r: BenchResponse) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private listenerInstalled = false;

  ensureListener() {
    if (this.listenerInstalled) return;
    this.listenerInstalled = true;
    unstable_messagePort.addListener("message", (msg) => {
      if (
        !msg ||
        typeof msg !== "object" ||
        typeof (msg as Record<string, unknown>).id !== "string"
      ) {
        return;
      }
      const m = msg as { id: string; result?: unknown; error?: { message: string } };
      const entry = this.pending.get(m.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(m.id);
        entry.resolve({ result: m.result, error: m.error });
      }
    });
  }

  request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<BenchResponse> {
    this.ensureListener();
    const id = `bench-${this.nextId++}`;
    return new Promise((resolve) => {
      // Timeout so a disconnected backend doesn't hang the run.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ error: { message: `bench rpc timeout after ${timeoutMs}ms (method=${method})` } });
        }
      }, timeoutMs);
      if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
      this.pending.set(id, { resolve, timer });
      unstable_messagePort.postMessage({ id, method, params } as never);
    });
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  // Linear interpolation between closest ranks (NumPy default).
  // Nearest-rank biases low for small samples.
  const position = (sortedAsc.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedAsc[lower]!;
  const weight = position - lower;
  return sortedAsc[lower]! + (sortedAsc[upper]! - sortedAsc[lower]!) * weight;
}

function summarise(samples: number[], sizeBytes: number): SizeStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    sizeBytes,
    count: sorted.length,
    min: sorted[0] ?? Number.NaN,
    max: sorted[sorted.length - 1] ?? Number.NaN,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

export default function App() {
  const [serviceState, setServiceState] = useState<ComapeoState>(state.getState());
  const [selected, setSelected] = useState<ReadonlyArray<number>>(DEFAULT_SELECTED);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [report, setReport] = useState<RunReport | null>(null);

  const clientRef = useRef<BenchClient | null>(null);
  if (!clientRef.current) clientRef.current = new BenchClient();

  useEffect(() => {
    const onChange = (next: ComapeoState) => setServiceState(next);
    state.addListener("stateChange", onChange);
    return () => {
      state.removeListener("stateChange", onChange);
    };
  }, []);

  const toggleSize = useCallback((size: number) => {
    setSelected((prev) =>
      prev.includes(size) ? prev.filter((s) => s !== size) : [...prev, size].sort((a, b) => a - b),
    );
  }, []);

  const runBench = useCallback(async () => {
    if (running) return;
    if (serviceState !== "STARTED") return;
    if (selected.length === 0) return;

    setRunning(true);
    setReport(null);
    const client = clientRef.current!;
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();
    const allSpans: BenchSpan[] = [];
    const stats: SizeStats[] = [];

    try {
      for (const sizeBytes of selected) {
        setProgress(`warmup ${formatBytes(sizeBytes)}…`);
        for (let i = 0; i < WARMUP_ITERATIONS; i++) {
          // Discard timing, just prime caches.
          await client.request("payload", { sizeBytes });
        }

        setProgress(`measuring ${formatBytes(sizeBytes)}…`);
        const samples: number[] = [];
        for (let i = 0; i < STEADY_ITERATIONS; i++) {
          const start = global.performance.now();
          const startMs = Date.now();
          const { error } = await client.request("payload", { sizeBytes });
          const durationMs = global.performance.now() - start;
          if (error) {
            console.warn(`bench: rpc.payload error at size ${sizeBytes}:`, error.message);
            continue;
          }
          samples.push(durationMs);
          const span: BenchSpan = {
            op: "rpc",
            name: "rpc.payload",
            startTimestamp: startMs,
            durationMs,
            attrs: { bytes: sizeBytes, rttSide: "rn", device: DEVICE_TAG },
          };
          allSpans.push(span);
        }
        stats.push(summarise(samples, sizeBytes));
      }

      // Persist the full NDJSON dump for export.
      const dir = new Directory(Paths.document, "comapeo-bench");
      if (!dir.exists) dir.create({ intermediates: true });
      const file = new File(dir, `${runId}.ndjson`);
      const ndjson = allSpans.map((s) => JSON.stringify({ ...s, runId })).join("\n") + "\n";
      file.create();
      file.write(ndjson);

      // Round-trip via bench RPC so backend re-emits to stdout:
      // RN's own console.log is suppressed by RCTLog's level filter
      // in iOS release builds and won't reach BS device logs.
      // Batched post-measurement to keep per-span overhead off the RTT.
      try {
        await client.request(
          "ingestSpans",
          { spans: allSpans.map((s) => ({ ...s, runId })) },
        );
      } catch (e) {
        console.warn("bench: ingestSpans failed", e);
      }

      setReport({
        runId,
        startedAt,
        device: { os: getOs() },
        stats,
        spanFile: file.uri,
      });
      setProgress(`done — ${allSpans.length} spans`);
    } catch (e) {
      console.error("bench: run failed", e);
      setProgress(`error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  }, [running, serviceState, selected]);

  const exportResults = useCallback(async () => {
    if (!report) return;
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        setProgress(`file: ${report.spanFile}`);
        return;
      }
      await Sharing.shareAsync(report.spanFile, {
        mimeType: "application/x-ndjson",
        dialogTitle: "Export bench results",
      });
    } catch (e) {
      console.warn("bench: export failed", e);
      setProgress(`export error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [report]);

  const canRun = serviceState === "STARTED" && !running && selected.length > 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
      >
        <Text style={styles.title} testID="header">
          UDS / RPC Bridge Benchmark
        </Text>

        <Group name="Backend">
          <Row label="state">
            <Text testID="service-state">{serviceState}</Text>
          </Row>
        </Group>

        <Group name="Payload sizes">
          <View style={styles.sizeRow}>
            {PAYLOAD_SIZES.map((s) => {
              const active = selected.includes(s);
              return (
                <Pressable
                  key={s}
                  onPress={() => toggleSize(s)}
                  style={[styles.sizeChip, active && styles.sizeChipActive]}
                  testID={`size-${s}`}
                >
                  <Text style={active ? styles.sizeChipTextActive : styles.sizeChipText}>
                    {formatBytes(s)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Group>

        <Pressable
          onPress={runBench}
          disabled={!canRun}
          style={[styles.button, !canRun && styles.buttonDisabled]}
          testID="send-button"
        >
          <Text style={styles.buttonText}>
            {running ? `Running… ${progress}` : "Run benchmark"}
          </Text>
        </Pressable>

        {report && (
          <View testID="benchmark-result">
            <Group name={`Results — ${report.runId}`}>
              <Text style={styles.subtle}>started {report.startedAt}</Text>
              <View style={styles.table}>
                <View style={styles.tableHeaderRow}>
                  <Text style={[styles.tableCell, styles.tableHeader]}>size</Text>
                  <Text style={[styles.tableCell, styles.tableHeader]}>n</Text>
                  <Text style={[styles.tableCell, styles.tableHeader]}>p50</Text>
                  <Text style={[styles.tableCell, styles.tableHeader]}>p95</Text>
                  <Text style={[styles.tableCell, styles.tableHeader]}>p99</Text>
                </View>
                {report.stats.map((row) => (
                  <View style={styles.tableRow} key={row.sizeBytes}>
                    <Text style={styles.tableCell}>{formatBytes(row.sizeBytes)}</Text>
                    <Text style={styles.tableCell}>{row.count}</Text>
                    <Text style={styles.tableCell}>{row.p50.toFixed(2)}</Text>
                    <Text style={styles.tableCell}>{row.p95.toFixed(2)}</Text>
                    <Text style={styles.tableCell}>{row.p99.toFixed(2)}</Text>
                  </View>
                ))}
              </View>
              <Text style={styles.subtle}>(durations in ms, RN-thread RTT)</Text>
              <Pressable
                onPress={exportResults}
                style={styles.exportButton}
                testID="export-button"
              >
                <Text style={styles.exportButtonText}>Export results (NDJSON)</Text>
              </Pressable>
              <Text style={styles.subtle} numberOfLines={2} ellipsizeMode="middle">
                {report.spanFile}
              </Text>
            </Group>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Group(props: { name: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupHeader}>{props.name}</Text>
      {props.children}
    </View>
  );
}

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{props.label}</Text>
      {props.children}
    </View>
  );
}

function getOs(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Platform = require("react-native").Platform as { OS: string };
  return Platform.OS;
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#eee",
  },
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  title: {
    fontSize: 26,
    margin: 20,
    fontWeight: "600",
  },
  group: {
    margin: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 16,
  },
  groupHeader: {
    fontSize: 16,
    marginBottom: 10,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginVertical: 4,
  },
  rowLabel: {
    color: "#666",
  },
  sizeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  sizeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#bbb",
    marginRight: 8,
    marginBottom: 8,
  },
  sizeChipActive: {
    backgroundColor: "#0070f3",
    borderColor: "#0070f3",
  },
  sizeChipText: {
    color: "#333",
  },
  sizeChipTextActive: {
    color: "#fff",
    fontWeight: "600",
  },
  button: {
    marginHorizontal: 12,
    marginVertical: 8,
    backgroundColor: "#0070f3",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonDisabled: {
    backgroundColor: "#9bb",
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
  table: {
    marginTop: 8,
  },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderColor: "#eee",
    paddingBottom: 4,
    marginBottom: 4,
  },
  tableHeader: {
    fontWeight: "600",
    color: "#666",
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 4,
  },
  tableCell: {
    flex: 1,
    fontVariant: ["tabular-nums"],
  },
  subtle: {
    color: "#888",
    fontSize: 12,
    marginTop: 6,
  },
  exportButton: {
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 6,
    backgroundColor: "#eef4ff",
    alignItems: "center",
  },
  exportButtonText: {
    color: "#0070f3",
    fontWeight: "600",
  },
});
