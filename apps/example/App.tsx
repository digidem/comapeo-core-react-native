import {
  comapeo,
  state,
  type ComapeoErrorInfo,
  type ComapeoState,
} from "@comapeo/core-react-native";
import React, { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

let renderCount = 0;

export default function App() {
  const [projects, setProjects] = useState<unknown[]>([]);
  const [comapeoState, setComapeoState] = useState<ComapeoState>(() =>
    state.getState(),
  );
  const [comapeoError, setComapeoError] = useState<ComapeoErrorInfo | null>(
    () => state.getLastError(),
  );

  useEffect(() => {
    comapeo.listProjects().then(setProjects);
  }, []);

  useEffect(() => {
    const sub = state.addListener("stateChange", (next, error) => {
      setComapeoState(next);
      setComapeoError(error);
    });
    return () => {
      sub.remove();
    };
  }, []);

  // TEMPORARY: undici-on-iOS smoke check. The backend runs
  // `runUndiciSmokeTest` between `started` and `init`, so by the time
  // we reach `STARTED` here, fetch worked. A failure surfaces as
  // `state === "ERROR"` with `errorPhase === "undici-smoke-test"`.
  const undiciSmoke =
    comapeoError?.errorPhase === "undici-smoke-test"
      ? `FAILED: ${comapeoError.errorMessage}`
      : comapeoState === "STARTED"
        ? "PASSED"
        : `pending (state=${comapeoState})`;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.container}>
        <Text style={styles.header} testID="header">
          Module API Example
        </Text>

        <Group name="Projects">
          <Text>{projects.length}</Text>
        </Group>
        <Group name="Render count">
          <Text testID="render-count">{renderCount++}</Text>
        </Group>
        <Group name="Comapeo state">
          <Text testID="comapeo-state">{comapeoState}</Text>
        </Group>
        <Group name="Undici smoke test">
          <Text testID="undici-smoke">{undiciSmoke}</Text>
        </Group>
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

const styles = {
  header: {
    fontSize: 30,
    margin: 20,
  },
  groupHeader: {
    fontSize: 20,
    marginBottom: 20,
  },
  group: {
    margin: 20,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 20,
  },
  container: {
    flex: 1,
    backgroundColor: "#eee",
  },
  view: {
    flex: 1,
    height: 200,
  },
};
