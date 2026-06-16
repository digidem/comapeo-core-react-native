import { comapeo, appRpcClient } from "@comapeo/core-react-native";
import * as Sentry from "@sentry/react-native";
import React, { useEffect, useState } from "react";
import { Button, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// `initSentry` is called in `index.ts` (with `Sentry.wrap` around
// the root component for app-start tracking). Don't call it again
// here — it throws on second init by design.

let renderCount = 0;

const mapServerListenPromise = appRpcClient.mapServer.listen();

const mapServerApi = {
  async getBaseUrl() {
    const { localPort } = await mapServerListenPromise;
    return new URL(`http://127.0.0.1:${localPort}`);
  },
};

export default function App() {
  const [projects, setProjects] = useState<unknown[]>([]);

  useEffect(() => {
    comapeo.listProjects().then(setProjects);
  }, []);

  const [mapServerUrl, setMapServerUrl] = useState<string | undefined>(
    undefined,
  );

  useEffect(() => {
    mapServerApi
      .getBaseUrl()
      .then((url) => {
        setMapServerUrl(url.href);
      })
      .catch((err) => {
        console.error("Failed to get map server URL:", err);
      });
  }, []);

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
        <Group name="Sentry smoke">
          <Button
            title="Capture RN-side exception"
            onPress={() => {
              Sentry.captureException(
                new Error("smoke-test: RN-side exception"),
              );
            }}
          />
          <Button
            title="Reload projects (warm listProjects)"
            onPress={() => {
              comapeo.listProjects().then(setProjects);
            }}
          />
        </Group>

        <Group name="Map server">
          <Text>{mapServerUrl}</Text>
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
