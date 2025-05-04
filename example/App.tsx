import { useEvent } from 'expo';
import { messagePort, state } from '@comapeo/core-react-native';
import { Button, SafeAreaView, ScrollView, Text, View } from 'react-native';

let renderCount = 0;

console.log("initial state:", state.getState());

export default function App() {
  const onChangePayload = useEvent(messagePort, 'message');
  const serverState = useEvent(state, 'stateChange', state.getState());

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
              for (let i = 0; i < 1000; i++) {
                messagePort.postMessage(`Hello ${i} from React Native!`);
              }
            }}
          />
        </Group>
        <Group name="Received Messages">
          <Text>{JSON.stringify(onChangePayload)}</Text>
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
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 20,
  },
  container: {
    flex: 1,
    backgroundColor: '#eee',
  },
  view: {
    flex: 1,
    height: 200,
  },
};
