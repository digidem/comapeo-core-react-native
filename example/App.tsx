import { comapeo } from "@comapeo/core-react-native";
import { SafeAreaView, ScrollView, Text, View } from "react-native";
import React, { useEffect, useState } from "react";

let renderCount = 0;

export default function App() {
  const [projects, setProjects] = useState<unknown[]>([]);

  useEffect(() => {
    comapeo.listProjects().then(setProjects);
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
