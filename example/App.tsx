import { useEvent } from "expo";
import { messagePort, state } from "@comapeo/core-react-native";
import { Button, SafeAreaView, ScrollView, Text, View } from "react-native";
import { faker } from "@faker-js/faker";
import React from "react";

let renderCount = 0;

const MSG_COUNT = 1000;
const fixtureStart = Date.now();
faker.seed("nodejs-mobile-test-messages");
const MESSAGE_FIXTURES = Array.from({ length: MSG_COUNT }, createRandomUser);
const fixtureTime = Date.now() - fixtureStart;

console.log("initial state:", state.getState());

export default function App() {
  // const onChangePayload = useEvent(messagePort, "message");
  const serverState = useEvent(state, "stateChange", state.getState());
  const timerRef = React.useRef(0);
  const [benchmark, setBenchmark] = React.useState<null | number>(null);

  React.useEffect(() => {
    const subscription = messagePort.addListener("message", (msg) => {
      if (msg.id === MSG_COUNT) {
        const totalTime = Date.now() - timerRef.current;
        setBenchmark(totalTime);
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.container}>
        <Text style={styles.header}>Module API Example</Text>
        <Group name="State">
          <Text>{serverState}</Text>
        </Group>
        <Group name="Message Server">
          <Button
            title="Send"
            onPress={async () => {
              timerRef.current = Date.now();
              for (const msg of MESSAGE_FIXTURES) {
                messagePort.postMessage(msg);
              }
            }}
          />
        </Group>
        <Group name="Received Messages">
          {benchmark === null ? null : (
            <Text>
              Received {MSG_COUNT} messages in {benchmark}ms
            </Text>
          )}
        </Group>
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

function createRandomUser(_, i) {
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
