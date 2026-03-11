import { useEvent } from "expo";
import { comapeo } from "@comapeo/core-react-native";
import { Button, SafeAreaView, ScrollView, Text, View } from "react-native";
import { faker } from "@faker-js/faker";
import React from "react";

let renderCount = 0;

export default function App() {
  const projects = React.use(comapeo.listProjects());
  console.log("Projects", projects);
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.container}>
        <Text style={styles.header}>Module API Example</Text>

        <Group name="Received Messages">{projects.length}</Group>
        <Group name="Render count">
          <Text>{renderCount++}</Text>
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

function createRandomUser(_: any, i: number) {
  return {
    id: i + 1,
    uuid: faker.string.uuid(),
    avatar: faker.image.avatar(),
    birthday: faker.date.birthdate().toISOString(),
    email: faker.internet.email(),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    sex: faker.person.sexType(),
    subscriptionTier: faker.helpers.arrayElement(["free", "basic", "business"]),
  };
}
